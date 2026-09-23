import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.mjs";

const AUTH_BASE = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
const SESSION_KEY = "ewp_forecast_supabase_session_v08";
const LAST_EMAIL_KEY = "ewp_forecast_last_email_v08";
const REFRESH_MARGIN_SECONDS = 60;

let session = null;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeSession(value) {
  if (!value || typeof value !== "object" || !value.access_token || !value.refresh_token) return null;
  const expiresAt = Number(value.expires_at || (nowSeconds() + Number(value.expires_in || 3600)));
  return { ...value, expires_at: expiresAt };
}

function saveSession(next) {
  session = normalizeSession(next);
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch (error) {
    console.warn("Could not persist auth session", error);
  }
  return session;
}

function loadStoredSession() {
  try {
    return normalizeSession(JSON.parse(localStorage.getItem(SESSION_KEY) || "null"));
  } catch {
    return null;
  }
}

async function authRequest(path, { method = "POST", body, accessToken } = {}) {
  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Accept: "application/json"
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${AUTH_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }

  if (!response.ok) {
    const message = data?.msg || data?.message || data?.error_description || data?.error || (typeof data === "string" ? data : "") || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function getCurrentSession() {
  return session;
}

export function getCurrentUser() {
  return session?.user || null;
}

export function getLastEmail() {
  try { return localStorage.getItem(LAST_EMAIL_KEY) || ""; }
  catch { return ""; }
}

export async function signInWithPassword(email, password) {
  const cleanEmail = String(email || "").trim();
  if (!cleanEmail || !password) throw new Error("Enter your email and password.");
  const data = await authRequest("/token?grant_type=password", {
    body: { email: cleanEmail, password }
  });
  saveSession(data);
  try { localStorage.setItem(LAST_EMAIL_KEY, cleanEmail); } catch {}
  return session;
}

export async function refreshSession() {
  const current = session || loadStoredSession();
  if (!current?.refresh_token) {
    saveSession(null);
    return null;
  }
  try {
    const data = await authRequest("/token?grant_type=refresh_token", {
      body: { refresh_token: current.refresh_token }
    });
    return saveSession(data);
  } catch (error) {
    saveSession(null);
    throw error;
  }
}

export async function restoreSession() {
  session = loadStoredSession();
  if (!session) return null;
  if (Number(session.expires_at || 0) <= nowSeconds() + REFRESH_MARGIN_SECONDS) {
    try { await refreshSession(); }
    catch { return null; }
  }
  return session;
}

export async function getAccessToken() {
  if (!session) await restoreSession();
  if (!session) return "";
  if (Number(session.expires_at || 0) <= nowSeconds() + REFRESH_MARGIN_SECONDS) {
    await refreshSession();
  }
  return session?.access_token || "";
}

export async function signOut() {
  const token = session?.access_token;
  if (token) {
    try { await authRequest("/logout", { method: "POST", accessToken: token }); }
    catch (error) { console.warn("Supabase sign-out request failed; clearing local session anyway", error); }
  }
  saveSession(null);
}
