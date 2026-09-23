import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.mjs";
import { getAccessToken } from "./auth.mjs";

const REST_URL = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;

function queryString(params = {}) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}

async function request(table, { method = "GET", params = {}, body, prefer = "", signal } = {}) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error("Authentication required. Please sign in again.");

  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json"
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const response = await fetch(`${REST_URL}/${table}${queryString(params)}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }

  if (!response.ok) {
    const message = data?.message || data?.details || data?.hint || (typeof data === "string" ? data : "") || `${response.status} ${response.statusText}`;
    throw new Error(`Supabase ${method} ${table} failed: ${message}`);
  }
  return data;
}

export async function loadCloudRows() {
  const [projects, levels, materials, deliveries] = await Promise.all([
    request("projects", { params: { select: "*", order: "created_at.asc" } }),
    request("levels", { params: { select: "*", order: "display_order.asc,created_at.asc" } }),
    request("materials", { params: { select: "*", order: "created_at.asc" } }),
    request("deliveries", { params: { select: "*", order: "delivered_at.asc,created_at.asc" } })
  ]);
  return { projects: projects || [], levels: levels || [], materials: materials || [], deliveries: deliveries || [] };
}

export async function insertRows(table, rows) {
  const payload = Array.isArray(rows) ? rows : [rows];
  if (!payload.length) return [];
  return request(table, { method: "POST", body: payload, prefer: "return=representation" });
}

export async function updateRows(table, params, values) {
  return request(table, { method: "PATCH", params, body: values, prefer: "return=representation" });
}

export async function deleteRows(table, params) {
  return request(table, { method: "DELETE", params, prefer: "return=representation" });
}

export async function logActivity(entityType, entityId, action, details = {}) {
  try {
    await insertRows("activity_log", {
      entity_type: entityType,
      entity_id: entityId || null,
      action,
      details
    });
  } catch (error) {
    // Activity logging should never block operational work.
    console.warn("Activity log write failed", error);
  }
}
