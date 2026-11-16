require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false } });
const secret = process.env.JWT_SECRET || "development-only-change-me";

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS articles (id SERIAL PRIMARY KEY, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, excerpt TEXT DEFAULT '', content TEXT NOT NULL, category TEXT DEFAULT 'World', image_url TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', author TEXT DEFAULT 'ZEDEX AI', source_url TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW(), published_at TIMESTAMPTZ);
  `);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO NOTHING", [process.env.ADMIN_EMAIL, hash]);
  }
}
function auth(req,res,next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try { req.user = jwt.verify(token, secret); next(); } catch { res.status(401).json({error:"Sign in required"}); }
}
function admin(req,res,next) { if(req.user.role !== "admin") return res.status(403).json({error:"Admin only"}); next(); }
const slugify = s => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,70) || "article";

app.get("/api/health", (req,res)=>res.json({ok:true,site:"ZEDEX NEXUS"}));
app.get("/api/articles", async (req,res)=>{
  try { const {rows}=await pool.query("SELECT id,title,slug,excerpt,content,category,image_url,author,source_url,published_at,created_at FROM articles WHERE status='published' ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 50"); res.json(rows); }
  catch(e){res.status(500).json({error:"Could not load articles"});}
});
app.get("/api/articles/:slug", async(req,res)=>{
  try { const {rows}=await pool.query("SELECT * FROM articles WHERE slug=$1 AND status='published'",[req.params.slug]); if(!rows[0])return res.status(404).json({error:"Not found"}); res.json(rows[0]); } catch(e){res.status(500).json({error:"Database error"});}
});
app.post("/api/login", async(req,res)=>{
  try { const email=String(req.body.email||"").toLowerCase(), password=String(req.body.password||""); const {rows}=await pool.query("SELECT * FROM users WHERE email=$1",[email]); if(!rows[0] || !(await bcrypt.compare(password,rows[0].password_hash)))return res.status(401).json({error:"Invalid email or password"}); const token=jwt.sign({id:rows[0].id,email,role:rows[0].role},secret,{expiresIn:"12h"}); res.json({token,role:rows[0].role,email}); } catch(e){res.status(500).json({error:"Login failed"});}
});
app.get("/api/admin/articles",auth,async(req,res)=>{try{const {rows}=await pool.query("SELECT * FROM articles ORDER BY created_at DESC LIMIT 100");res.json(rows);}catch(e){res.status(500).json({error:"Could not load"});}});
app.post("/api/admin/articles",auth,async(req,res)=>{
  try { const b=req.body; if(!b.title||!b.content)return res.status(400).json({error:"Title and content required"}); const slug=slugify(b.title)+"-"+Date.now().toString(36); const status=b.status==="published"?"published":"draft"; const {rows}=await pool.query("INSERT INTO articles(title,slug,excerpt,content,category,image_url,status,author,source_url,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $7='published' THEN NOW() ELSE NULL END) RETURNING *",[b.title,slug,b.excerpt||"",b.content,b.category||"World",b.image_url||"",status,req.user.email,b.source_url||""]);res.status(201).json(rows[0]); } catch(e){res.status(500).json({error:"Could not save article"});}
});
app.put("/api/admin/articles/:id",auth,async(req,res)=>{
  try {const b=req.body;const status=b.status==="published"?"published":"draft";const {rows}=await pool.query("UPDATE articles SET title=$1,excerpt=$2,content=$3,category=$4,image_url=$5,status=$6,source_url=$7,published_at=CASE WHEN $6='published' THEN COALESCE(published_at,NOW()) ELSE NULL END WHERE id=$8 RETURNING *",[b.title,b.excerpt||"",b.content,b.category||"World",b.image_url||"",status,b.source_url||"",req.params.id]);if(!rows[0])return res.status(404).json({error:"Article not found"});res.json(rows[0]);}catch(e){res.status(500).json({error:"Could not update"});}
});
app.post("/api/admin/users",auth,admin,async(req,res)=>{
  try{const email=String(req.body.email||"").toLowerCase(),password=String(req.body.password||""),role=req.body.role==="publisher"?"publisher":"editor";if(!email||password.length<10)return res.status(400).json({error:"Email and password (10+ characters) required"});const hash=await bcrypt.hash(password,12);await pool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3)",[email,hash,role]);res.status(201).json({ok:true});}catch(e){res.status(400).json({error:"Could not create user; email may already exist"});}
});
async function generateWithAI() {
  const provider=(process.env.AI_PROVIDER||"groq").toLowerCase();
  const prompt='Create one concise, factual news article idea for a general audience. Return ONLY JSON with keys title,excerpt,content,category,source_url. Do not invent facts or citations. If you cannot verify a current event, create a clearly labelled evergreen explainer instead.';
  if(provider==="gemini" && process.env.GEMINI_API_KEY){
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+process.env.GEMINI_API_KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})});
    const j=await r.json();if(!r.ok)throw new Error("Gemini request failed");return JSON.parse(j.candidates[0].content.parts[0].text.replace(/```json|\`\`\`/g,"").trim());
  }
  if(!process.env.GROQ_API_KEY)throw new Error("Set GROQ_API_KEY or select Gemini");
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+process.env.GROQ_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:"llama-3.3-70b-versatile",messages:[{role:"user",content:prompt}],temperature:0.4})});
  const j=await r.json();if(!r.ok)throw new Error("Groq request failed");return JSON.parse(j.choices[0].message.content.replace(/```json|\`\`\`/g,"").trim());
}
async function scheduledDraft() {
  try {const a=await generateWithAI();if(!a.title||!a.content)throw new Error("AI returned incomplete article");const slug=slugify(a.title)+"-"+Date.now().toString(36);await pool.query("INSERT INTO articles(title,slug,excerpt,content,category,status,author,source_url) VALUES($1,$2,$3,$4,$5,'draft','ZEDEX AI',$6)",[a.title,slug,a.excerpt||"",a.content,a.category||"World",a.source_url||""]);console.log("AI article saved as draft:",a.title);}catch(e){console.error("Scheduled AI draft failed:",e.message);}
}
app.post("/api/admin/ai-generate",auth,async(req,res)=>{try{await scheduledDraft();res.json({ok:true,message:"AI article generated as a draft. Review it in the editor."});}catch(e){res.status(500).json({error:e.message});}});
cron.schedule("0 6,12,18,0 * * *",scheduledDraft,{timezone:"Asia/Kolkata"});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const port=process.env.PORT||10000;
init().then(()=>app.listen(port,()=>console.log("ZEDEX NEXUS listening on",port))).catch(e=>{console.error("Startup failed",e);process.exit(1);});
