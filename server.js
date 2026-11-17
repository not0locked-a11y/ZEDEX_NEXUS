require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const multer = require("multer");
const { Pool } = require("pg");
const drive = require("./drive-storage");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false } });
const secret = process.env.JWT_SECRET || "development-only-change-me";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_req,file,cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) });

function logDriveError(operation, err) {
  const safeMessage = String(err?.message || err || "Unknown error")
    .replace(/(access_token|refresh_token|client_secret|authorization)\s*[:=]\s*[^\s,]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
  console.error(`[Google Drive] ${operation} failed`, {
    name: err?.name || "Error",
    code: err?.code || err?.response?.status || null,
    message: safeMessage
  });
}

async function init() {
  // PostgreSQL is intentionally limited to user accounts and authentication data.
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at TIMESTAMPTZ DEFAULT NOW())`);
  // Move legacy article rows to Drive before removing the old PostgreSQL content table.
  const legacy = await pool.query("SELECT to_regclass('public.articles') AS table_name");
  if (legacy.rows[0].table_name) {
    const oldRows = await pool.query("SELECT * FROM articles ORDER BY id");
    for (const row of oldRows.rows) {
      await drive.createJson("article", {
        title: row.title, slug: (row.slug || slugify(row.title)) + "-migrated-" + row.id,
        excerpt: row.excerpt || "", content: row.content || "",
        category: row.category || "World", image_url: row.image_url || "",
        status: row.status || "draft", author: row.author || "ZEDEX NEXUS",
        source_url: row.source_url || "", published_at: row.published_at || null
      });
    }
    await pool.query("DROP TABLE articles");
    console.log("Legacy articles migrated to Google Drive; PostgreSQL article table removed.");
  }
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO NOTHING", [process.env.ADMIN_EMAIL.toLowerCase(), hash]);
  }
}
function auth(req,res,next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try { req.user = jwt.verify(token, secret); next(); } catch { res.status(401).json({error:"Sign in required"}); }
}
function admin(req,res,next) { if(req.user.role !== "admin") return res.status(403).json({error:"Admin only"}); next(); }
const slugify = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,70) || "article";
const publicArticle = a => ({ id:a.id, title:a.title, slug:a.slug, excerpt:a.excerpt, content:a.content, category:a.category, image_url:a.image_url, author:a.author, source_url:a.source_url, status:a.status, created_at:a.created_at, published_at:a.published_at });

app.get("/api/health", (_req,res)=>res.json({ok:true,site:"ZEDEX NEXUS",contentStorage:"Google Drive",userStorage:"Render PostgreSQL"}));
app.get("/api/articles", async (_req,res)=>{
  try { const files=await drive.listContent("article"); const items=(await Promise.all(files.map(f=>drive.readJson(f.id)))).filter(a=>a.status==="published").sort((a,b)=>String(b.published_at||b.created_at).localeCompare(String(a.published_at||a.created_at))).slice(0,50); res.json(items.map(publicArticle)); }
  catch(e){logDriveError("public article list",e);res.status(503).json({error:"Could not load articles from Google Drive. Check Drive configuration."});}
});
app.get("/api/articles/:slug", async(req,res)=>{
  try { const files=await drive.listContent("article"); for(const f of files){const a=await drive.readJson(f.id);if(a.slug===req.params.slug&&a.status==="published")return res.json(publicArticle(a));} res.status(404).json({error:"Not found"}); }
  catch(e){logDriveError("public article detail",e);res.status(503).json({error:"Could not load article from Google Drive"});}
});
app.get("/api/media/:id", async(req,res)=>{
  try { const m=await drive.getMedia(req.params.id);res.setHeader("Content-Type",m.mimeType);res.setHeader("Cache-Control","public, max-age=3600");m.stream.pipe(res); }
  catch(e){res.status(404).json({error:"Media not found"});}
});
app.post("/api/login", async(req,res)=>{
  try { const email=String(req.body.email||"").toLowerCase(), password=String(req.body.password||""); const {rows}=await pool.query("SELECT * FROM users WHERE email=$1",[email]); if(!rows[0] || !(await bcrypt.compare(password,rows[0].password_hash)))return res.status(401).json({error:"Invalid email or password"}); const token=jwt.sign({id:rows[0].id,email,role:rows[0].role},secret,{expiresIn:"12h"}); res.json({token,role:rows[0].role,email}); } catch(e){res.status(500).json({error:"Login failed"});}
});
app.get("/api/admin/articles",auth,async(req,res)=>{
  try {const files=await drive.listContent("article");const items=await Promise.all(files.map(f=>drive.readJson(f.id)));res.json(items.sort((a,b)=>String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at))));}
  catch(e){logDriveError("admin article list",e);res.status(503).json({error:"Could not load articles from Google Drive"});}
});
app.post("/api/admin/articles",auth,async(req,res)=>{
  try {const b=req.body;if(!b.title||!b.content)return res.status(400).json({error:"Title and content required"});const status=b.status==="published"?"published":"draft";const slug=slugify(b.title)+"-"+Date.now().toString(36);const a=await drive.createJson("article",{title:b.title,slug,excerpt:b.excerpt||"",content:b.content,category:b.category||"World",image_url:b.image_url||"",status,author:req.user.email,source_url:b.source_url||"",published_at:status==="published"?new Date().toISOString():null});res.status(201).json(a);}
  catch(e){logDriveError("article create",e);res.status(503).json({error:"Could not save article to Google Drive. Check Drive configuration."});}
});
app.delete("/api/admin/articles/:id",auth,admin,async(req,res)=>{
  try {
    await drive.deleteArticle(req.params.id);
    res.json({ok:true,message:"Article deleted from Google Drive."});
  } catch(e) {
    logDriveError("article delete",e);
    res.status(503).json({error:"Could not delete article from Google Drive"});
  }
});
app.put("/api/admin/articles/:id",auth,async(req,res)=>{
  try {const b=req.body;const status=b.status==="published"?"published":"draft";const a=await drive.updateJson("article",req.params.id,{title:b.title,excerpt:b.excerpt||"",content:b.content,category:b.category||"World",image_url:b.image_url||"",status,source_url:b.source_url||"",published_at:status==="published"?new Date().toISOString():null});res.json(a);}
  catch(e){logDriveError("article update",e);res.status(503).json({error:"Could not update article in Google Drive"});}
});
app.post("/api/admin/media",auth,upload.single("file"),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:"Choose a JPG, PNG, WEBP or GIF image (max 15 MB)."});
  try {res.status(201).json(await drive.uploadMedia(req.file));}
  catch(e){logDriveError("media upload",e);res.status(503).json({error:"Could not upload image to Google Drive"});}
});
app.post("/api/admin/users",auth,admin,async(req,res)=>{
  try{const email=String(req.body.email||"").toLowerCase(),password=String(req.body.password||""),role=req.body.role==="publisher"?"publisher":"editor";if(!email||password.length<10)return res.status(400).json({error:"Email and password (10+ characters) required"});const hash=await bcrypt.hash(password,12);await pool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3)",[email,hash,role]);res.status(201).json({ok:true});}catch(e){res.status(400).json({error:"Could not create user; email may already exist"});}
});
async function generateWithAI() {
  const provider=(process.env.AI_PROVIDER||"groq").toLowerCase();
  const prompt='Create one concise, factual news article idea for a general audience. Return ONLY JSON with keys title,excerpt,content,category,source_url. Do not invent facts or citations. If you cannot verify a current event, create a clearly labelled evergreen explainer instead.';
  async function generateWithGemini() {
    if(!process.env.GEMINI_API_KEY)throw new Error("GEMINI_API_KEY is not configured");
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key="+process.env.GEMINI_API_KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){
      const detail=String(j?.error?.message||"No error details returned").slice(0,300);
      console.error("[Gemini] request failed",{status:r.status,message:detail});
      throw new Error("Gemini API error ("+r.status+"): "+detail);
    }
    const output=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("")||"";
    if(!output)throw new Error("Gemini returned an empty response");
    return JSON.parse(output.replace(/```json|```/g,"").trim());
  }
  async function generateWithGroq() {
    if(!process.env.GROQ_API_KEY)throw new Error("GROQ_API_KEY is not configured");
    const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+process.env.GROQ_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-120b",messages:[{role:"user",content:prompt}],temperature:0.4})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){
      const detail=String(j?.error?.message||j?.message||"No error details returned").slice(0,300);
      console.error("[Groq] request failed",{status:r.status,code:j?.error?.code||null,type:j?.error?.type||null,message:detail});
      throw new Error("Groq API error ("+r.status+"): "+detail);
    }
    const output=j?.choices?.[0]?.message?.content;
    if(!output)throw new Error("Groq returned an empty response");
    return JSON.parse(output.replace(/```json|```/g,"").trim());
  }
  if(provider==="gemini")return generateWithGemini();
  try {
    return await generateWithGroq();
  } catch(groqError) {
    console.error("[AI] Groq failed; trying Gemini fallback:",String(groqError.message||groqError).slice(0,300));
    try {
      const article=await generateWithGemini();
      console.log("[AI] Gemini fallback succeeded.");
      return article;
    } catch(geminiError) {
      throw new Error("Groq failed ("+String(groqError.message||groqError).slice(0,180)+"); Gemini fallback failed ("+String(geminiError.message||geminiError).slice(0,180)+")");
    }
  }
}
async function generateAndPublish() {
  const a=await generateWithAI();
  if(!a.title||!a.content)throw new Error("AI returned incomplete article");
  const now=new Date().toISOString();
  const slug=slugify(a.title)+"-"+Date.now().toString(36);
  const article=await drive.createJson("article",{title:a.title,slug,excerpt:a.excerpt||"",content:a.content,category:a.category||"World",image_url:"",status:"published",author:"ZEDEX AI",source_url:a.source_url||"",published_at:now});
  console.log("AI article generated and PUBLISHED to Google Drive:",article.title);
  return article;
}
app.post("/api/admin/ai-generate",auth,admin,async(req,res)=>{
  const count=Number.parseInt(req.body.count,10)||1;
  if(count<1||count>10)return res.status(400).json({error:"Choose between 1 and 10 articles per request."});
  const published=[];
  for(let i=0;i<count;i++){
    try {
      const article=await generateAndPublish();
      published.push(publicArticle(article));
    } catch(e) {
      console.error("AI publish failed on article "+(i+1)+":",e.message);
      return res.status(500).json({error:"Published "+published.length+" of "+count+" requested articles. Failed on article "+(i+1)+": "+(e.message||"AI generation failed"),published});
    }
  }
  res.json({ok:true,message:published.length+" separate AI article(s) generated and published on ZEDEX NEXUS.",articles:published});
});
// Generate and publish at 6 AM, noon, 6 PM and midnight India time.
cron.schedule("0 6,12,18,0 * * *",()=>generateAndPublish().catch(e=>console.error("Scheduled AI publishing failed:",e.message)),{timezone:"Asia/Kolkata"});
const port=process.env.PORT||10000;
init().then(()=>app.listen(port,()=>console.log("ZEDEX NEXUS listening on",port))).catch(e=>{console.error("Startup failed",e);process.exit(1);});
