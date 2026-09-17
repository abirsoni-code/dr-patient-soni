/**
 * Firebase Cloud Function backend — reachable at /api (see firebase.json
 * hosting rewrite). Runs the same shared/dataEngine.cjs business logic as
 * the old Netlify Functions backend, now backed by Firestore + Firebase
 * Storage instead of Netlify Blobs (see store.js).
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const { handleAction } = require("./shared/dataEngine.cjs");
const { firestoreStore } = require("./store.js");

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const MAX_ATTEMPTS = 5;

async function runAction(req, res) {
  const action = req.method === "GET" ? req.query.action : req.body.action;
  const rawParams = req.method === "GET" ? { ...req.query } : { ...req.body };
  delete rawParams.action;

  // Never trust a client-supplied uid. If an idToken was sent, verify it
  // server-side and overwrite whatever uid the client claimed with the
  // real one from the token.
  const { idToken, ...params } = rawParams;
  delete params.uid;
  if (idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      params.uid = decoded.uid;
    } catch {
      return res.json({ ok: false, error: "Invalid or expired session. Please log in again." });
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Fresh store per attempt so it re-reads current data and version.
      const store = firestoreStore();
      const result = await handleAction(store, action, params);
      return res.json({ ok: true, data: result });
    } catch (err) {
      const isConflict = err && err.code === "CONFLICT";
      if (isConflict && attempt < MAX_ATTEMPTS) continue;
      // If registration failed after the Firebase Auth account was already
      // created (e.g. username taken), remove the orphaned Auth account
      // rather than leaving a login with no profile behind it.
      if (action === "register" && params.uid) {
        try { await admin.auth().deleteUser(params.uid); } catch { /* best effort */ }
      }
      return res.json({ ok: false, error: err.message });
    }
  }
}

app.get("/", runAction);
app.post("/", runAction);

exports.api = functions.https.onRequest(app);
