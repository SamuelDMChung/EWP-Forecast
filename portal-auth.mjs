import { restoreSession, signInWithPassword, signOut, getLastEmail, EWP_AUTH_STORAGE_KEY } from "./forecast/auth.mjs?v=1.0-p3";

const $ = id => document.getElementById(id);
let authenticated = false;

function safeNext() {
  const requested = new URLSearchParams(location.search).get("next") || "";
  // Stay within only the two local workspaces; never redirect to arbitrary hosts/paths.
  if (!/^(?:tracker|forecast)\/(?:\?[^#]*)?$/.test(requested)) return "";
  return requested;
}
function showError(message) {
  $("portalLoginError").textContent = message || "Could not sign in.";
  $("portalLoginError").hidden = !message;
}
function setSession(session) {
  authenticated = !!session?.user;
  $("portalAuthLoading").hidden = true;
  $("portalLogin").hidden = authenticated;
  $("portalWorkspace").hidden = !authenticated;
  if (authenticated) {
    $("portalCurrentEmail").textContent = session.user.email || "Signed-in employee";
    const next = safeNext();
    if (next) location.replace(new URL(next, location.href).href);
  }
}
async function init() {
  $("portalLoginEmail").value = getLastEmail();
  $("portalLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("portalLoginButton");
    button.disabled = true;
    button.textContent = "Signing in…";
    showError("");
    try {
      const session = await signInWithPassword($("portalLoginEmail").value, $("portalLoginPassword").value);
      $("portalLoginPassword").value = "";
      setSession(session);
    } catch (error) {
      showError(error?.message || "Sign-in failed. Please try again.");
    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });
  $("portalSignOut").addEventListener("click", async () => {
    if (!confirm("Sign out of EWP Management on this browser?")) return;
    await signOut();
    setSession(null);
  });
  window.addEventListener("storage", async event => {
    if (event.key !== EWP_AUTH_STORAGE_KEY) return;
    if (!event.newValue) { setSession(null); return; }
    try { setSession(await restoreSession()); }
    catch { setSession(null); }
  });
  try {
    setSession(await restoreSession());
  } catch (error) {
    $("portalAuthLoading").hidden = true;
    setSession(null);
    showError("Could not restore your session. Please sign in again.");
  }
}
init();
