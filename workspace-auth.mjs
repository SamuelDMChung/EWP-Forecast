import { restoreSession, EWP_AUTH_STORAGE_KEY } from "./forecast/auth.mjs?v=1.0-p3";
const label = document.getElementById("ewpNavAccount");
const workspace = location.pathname.includes("/tracker/") ? "tracker/" : "forecast/";
function redirectToPortal() {
  location.replace(new URL("../?next=" + encodeURIComponent(workspace + location.search), location.href).href);
}
function show(session) {
  if (label) label.textContent = session?.user?.email || "";
}
window.addEventListener("storage", async event => {
  if (event.key !== EWP_AUTH_STORAGE_KEY) return;
  if (!event.newValue) { redirectToPortal(); return; }
  try { show(await restoreSession()); } catch { redirectToPortal(); }
});
restoreSession().then(session => {
  if (!session?.user) redirectToPortal();
  else show(session);
}).catch(() => redirectToPortal());
