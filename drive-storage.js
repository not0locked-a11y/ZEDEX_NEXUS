const { google } = require("googleapis");
const { Readable } = require("stream");
const crypto = require("crypto");

function driveClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error("Google Drive is not configured. Add the Google OAuth credentials and folder ID in Render Environment.");
  }
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: oauth });
}
function folderId() {
  const id = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!id) throw new Error("GOOGLE_DRIVE_FOLDER_ID is missing");
  return id;
}
async function listContent(type) {
  const drive = driveClient();
  const q = "'" + folderId().replace(/'/g, "\\'") + "' in parents and trashed = false and appProperties has { key='zedexType' and value='" + type + "' }";
  const out = [];
  let pageToken;
  do {
    const r = await drive.files.list({ q, pageSize: 100, pageToken, orderBy: "createdTime desc", fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,appProperties)" });
    out.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}
async function readJson(id) {
  const drive = driveClient();
  const r = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "text" });
  return typeof r.data === "string" ? JSON.parse(r.data) : JSON.parse(String(r.data));
}
async function createJson(type, data) {
  const drive = driveClient();
  const id = crypto.randomUUID();
  const body = { ...data, id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const r = await drive.files.create({
    requestBody: { name: type + "-" + id + ".json", mimeType: "application/json", parents: [folderId()], appProperties: { zedexType: type } },
    media: { mimeType: "application/json", body: Readable.from([JSON.stringify(body)]) },
    fields: "id"
  });
  return { ...body, id: r.data.id };
}
async function updateJson(type, id, data) {
  const drive = driveClient();
  const old = await readJson(id);
  // Preserve the previous complete version as a separate Drive JSON file before overwriting.
  await createJson("revision", { articleId: id, snapshot: old });
  const body = { ...old, ...data, id, updated_at: new Date().toISOString() };
  await drive.files.update({ fileId: id, media: { mimeType: "application/json", body: Readable.from([JSON.stringify(body)]) } });
  return body;
}
async function uploadMedia(file) {
  const drive = driveClient();
  const safeName = String(file.originalname || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const r = await drive.files.create({
    requestBody: { name: Date.now() + "-" + safeName, mimeType: file.mimetype, parents: [folderId()], appProperties: { zedexType: "media" } },
    media: { mimeType: file.mimetype, body: Readable.from([file.buffer]) },
    fields: "id,name,mimeType"
  });
  return { id: r.data.id, name: r.data.name, mimeType: r.data.mimeType, url: "/api/media/" + r.data.id };
}
async function getMedia(id) {
  const drive = driveClient();
  const meta = await drive.files.get({ fileId: id, fields: "id,name,mimeType,parents" });
  if (!(meta.data.parents || []).includes(folderId())) throw new Error("Media is outside the ZEDEX NEXUS Drive folder");
  const file = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "stream" });
  return { mimeType: meta.data.mimeType, stream: file.data };
}
module.exports = { listContent, readJson, createJson, updateJson, uploadMedia, getMedia };
