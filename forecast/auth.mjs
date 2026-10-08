import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.mjs";

const AUTH_BASE = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
const SESSION_KEY = "ewp_forecast_supabase_session_v08";
const LAST_EMAIL_KEY = "ewp_forecast_last_email_v08";
const REFRESH_MARGIN_SECONDS = 60;
export const EWP_AUTH_STORAGE_KEY = SESSION_KEY;

let session = null;
let refreshInFlight = null;

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

async function refreshOnce() {
  // Read the latest persisted token: a sibling portal/tool tab may have rotated it.
  const newest = loadStoredSession();
  if (newest && newest.expires_at > nowSeconds() + REFRESH_MARGIN_SECONDS) {
    session = newest;
    return session;
  }
  const current = newest || session;
  if (!current?.refresh_token) return saveSession(null);
  try {
    const data = await authRequest("/token?grant_type=refresh_token", {
      body: { refresh_token: current.refresh_token }
    });
    return saveSession(data);
  } catch (error) {
    // A competing tab may have completed its refresh during our request.
    const replacement = loadStoredSession();
    if (replacement && replacement.refresh_token !== current.refresh_token &&
        replacement.expires_at > nowSeconds() + REFRESH_MARGIN_SECONDS) {
      session = replacement;
      return session;
    }
    saveSession(null);
    throw error;
  }
}

export async function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    // Lock across same-origin tabs where supported; keep no-lock fallback for other browsers.
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      return navigator.locks.request("ewp-management-supabase-refresh", refreshOnce);
    }
    return refreshOnce();
  })();
  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
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
  // Avoid using a stale token when another tab refreshed or signed out.
  const newest = loadStoredSession();
  if (!newest) session = null;
  else if (!session || newest.refresh_token !== session.refresh_token) session = newest;
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

// Shared across the Portal, Tracker, and Forecast on the same GitHub Pages origin.
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key !== SESSION_KEY) return;
    session = loadStoredSession();
  });
}
