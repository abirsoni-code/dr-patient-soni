/**
 * Netlify Function backend — stores data in Netlify Blobs (persists across
 * deploys and requests, no external database needed).
 * Deployed automatically by Netlify from /netlify/functions/api.js
 * Reachable at /.netlify/functions/api (redirected to /api — see netlify.toml)
 */
const { getStore } = require("@netlify/blobs");
const { handleAction, DEFAULT_DATA } = require("../../shared/dataEngine.cjs");

const BLOB_KEY = "db";

function blobStore() {
  const store = getStore("doctor-patient-app");
  const photoStore = getStore("doctor-patient-app-photos");
  return {
    async get() {
      const data = await store.get(BLOB_KEY, { type: "json" });
      return data || { ...DEFAULT_DATA };
    },
    async set(data) {
      await store.setJSON(BLOB_KEY, data);
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
    const store = blobStore();
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

    const result = await handleAction(store, action, params);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: result }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
