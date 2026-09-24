import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.mjs";
import { getAccessToken } from "./auth.mjs";

let client = null;
let channel = null;
let tokenRefreshTimer = null;

async function getClient() {
  if (client) return client;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.57.4");
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
  return client;
}

export async function refreshRealtimeAuth() {
  if (!client) return;
  const token = await getAccessToken();
  if (token) await client.realtime.setAuth(token);
}

export async function startRealtime({ onChange, onStatus } = {}) {
  await stopRealtime();
  try {
    const supabase = await getClient();
    const token = await getAccessToken();
    if (!token) throw new Error("Authentication required for live sync.");
    await supabase.realtime.setAuth(token);

    channel = supabase.channel("ewp-material-forecast-shared-v09");
    for (const table of ["projects", "levels", "materials", "deliveries", "inventory_materials", "incoming_orders", "activity_log"]) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        payload => onChange?.({ table, payload })
      );
    }

    channel.subscribe(status => {
      onStatus?.(status);
    });

    // Token maintenance only; this never downloads project/material tables.
    tokenRefreshTimer = window.setInterval(async () => {
      try { await refreshRealtimeAuth(); } catch (error) { console.warn("Realtime auth refresh failed", error); }
    }, 45 * 60 * 1000);

    return true;
  } catch (error) {
    console.warn("Realtime could not start", error);
    onStatus?.("CHANNEL_ERROR", error);
    return false;
  }
}

export async function stopRealtime() {
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
  if (client && channel) {
    try { await client.removeChannel(channel); } catch {}
  }
  channel = null;
}
