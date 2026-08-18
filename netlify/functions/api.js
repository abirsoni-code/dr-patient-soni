/**
 * Netlify Function backend — stores data in Netlify Blobs (persists across
 * deploys and requests, no external database needed).
 * Deployed automatically by Netlify from /netlify/functions/api.js
 * Reachable at /.netlify/functions/api (redirected to /api — see netlify.toml)
 */
const { getStore } = require("@netlify/blobs");
const { handleAction, DEFAULT_DATA, ConflictError } = require("../../shared/dataEngine.cjs");

const BLOB_KEY = "db";

// Each call gets its own store with its own etag tracking, so concurrent
// requests can't clobber each other's writes: the write only succeeds if
// nothing else has written to the "db" blob since this request read it.
function blobStore() {
  const store = getStore("doctor-patient-app");
  const photoStore = getStore("doctor-patient-app-photos");
  let lastEtag = null;
  let hasRead = false;
  return {
    async get() {
      const result = await store.getWithMetadata(BLOB_KEY, { type: "json" });
      lastEtag = result ? result.etag : null;
      hasRead = true;
      return (result && result.data) || { ...DEFAULT_DATA };
    },
    async set(data) {
      const opts = lastEtag ? { onlyIfMatch: lastEtag } : hasRead ? { onlyIfNew: true } : {};
      const result = await store.setJSON(BLOB_KEY, data, opts);
      if (!result || result.modified === false) {
        throw new ConflictError();
      }
      lastEtag = result.etag || lastEtag;
    },
    async getBlob(key) {
      const value = await photoStore.get(key, { type: "json" });
      return value || null;
    },
    async putBlob(key, value) {
      await photoStore.setJSON(key, value);
    },
    async deleteBlob(key) {
      await photoStore.delete(key);
    },
  };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    let action, params;

    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      action = q.action;
      params = { ...q };
      delete params.action;
    } else {
      const body = JSON.parse(event.body || "{}");
      action = body.action;
      params = { ...body };
      delete params.action;
    }

    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Fresh store per attempt so it re-reads current data and etag.
        const store = blobStore();
        const result = await handleAction(store, action, params);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: result }) };
      } catch (err) {
        const isConflict = err && err.code === "CONFLICT";
        if (isConflict && attempt < MAX_ATTEMPTS) continue;
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
      }
    }
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
