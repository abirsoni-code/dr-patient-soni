/**
 * Local dev backend — stores data in server/data/db.json.
 * Run with: npm run server
 * The frontend (Vite dev server) proxies /api requests here (see vite.config.js).
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { handleAction, DEFAULT_DATA } = require("../shared/dataEngine.cjs");

const DB_PATH = path.join(__dirname, "data", "db.json");
const PHOTOS_DIR = path.join(__dirname, "data", "photos");

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}

function ensurePhotosDir() {
  if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

const fileStore = {
  async get() {
    ensureDb();
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    try {
      return JSON.parse(raw);
    } catch {
      return { ...DEFAULT_DATA };
    }
  },
  async set(data) {
    ensureDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  },
  async getBlob(key) {
    ensurePhotosDir();
    const p = path.join(PHOTOS_DIR, `${key}.json`);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  },
  async putBlob(key, value) {
    ensurePhotosDir();
    fs.writeFileSync(path.join(PHOTOS_DIR, `${key}.json`), JSON.stringify(value));
  },
  async deleteBlob(key) {
    ensurePhotosDir();
    const p = path.join(PHOTOS_DIR, `${key}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  },
};

// Serializes all requests through the file store so two concurrent local
// requests can never interleave a read-modify-write and clobber each other
// (mirrors the etag-based protection used against Netlify Blobs in prod).
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

const app = express();
app.use(cors());
// Parse JSON regardless of Content-Type header — browsers' fetch() defaults to
// text/plain for string bodies unless the header is set explicitly, and we'd
// rather be lenient here than silently receive an empty body.
app.use(express.json({ type: () => true }));

app.get("/api", async (req, res) => {
  const { action, ...params } = req.query;
  try {
    const result = await withLock(() => handleAction(fileStore, action, params));
    res.json({ ok: true, data: result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post("/api", async (req, res) => {
  const { action, ...params } = req.body;
  try {
    const result = await withLock(() => handleAction(fileStore, action, params));
    res.json({ ok: true, data: result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

const PORT = 8787;
app.listen(PORT, () => {
  ensureDb();
  console.log(`Local backend running at http://localhost:${PORT}/api`);
  console.log(`Data stored in ${DB_PATH}`);
});
