/**
 * Firebase Cloud Function backend — scaffold.
 *
 * This deploys and responds at /api (via the hosting rewrite in
 * firebase.json), but does not yet run the app's real business logic.
 * Step 2 wires this up to shared/dataEngine.cjs with a Firestore-backed
 * store, replacing the Netlify Functions + Blobs backend.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Firebase Functions backend scaffold is live. Business logic not yet wired." });
});

app.post("/", (req, res) => {
  res.json({ ok: true, message: "Firebase Functions backend scaffold is live. Business logic not yet wired." });
});

exports.api = functions.https.onRequest(app);
