import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../forecast/config.mjs';
import { getAccessToken } from '../forecast/auth.mjs?v=1.0-p3';

let client = null;
let channel = null;
let refreshTimer = null;

export async function startTrackerRealtime(onChange, onStatus) {
  await stopTrackerRealtime();
  try {
    // Same library already used by Forecast; on-demand, optional enhancement.
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.57.4');
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const token = await getAccessToken();
    if (!token) return false;
    await client.realtime.setAuth(token);
    channel = client.channel('ewp-tracker-shared-v1-p3');
    for (const table of ['projects', 'tracker_work_items', 'tracker_settings', 'tracker_saved_filters']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => onChange?.(payload));
    }
    channel.subscribe(status => onStatus?.(status));
    refreshTimer = window.setInterval(async () => {
      try {
        const newest = await getAccessToken();
        if (newest && client) await client.realtime.setAuth(newest);
      } catch (error) { console.warn('Tracker realtime token refresh failed', error); }
    }, 40 * 60 * 1000);
    return true;
  } catch (error) {
    console.warn('Tracker Realtime unavailable; foreground sync remains active.', error);
    onStatus?.('CHANNEL_ERROR');
    return false;
  }
}

export async function stopTrackerRealtime() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (client && channel) {
    try { await client.removeChannel(channel); } catch {}
  }
  channel = null;
  client = null;
}
