// Browser-safe Supabase connection settings for the authenticated team app.
// IMPORTANT: Only use a Supabase publishable/anon key here. Never put a secret/service-role key in GitHub Pages.
export const SUPABASE_URL = "https://dmlodguzwgsbbirptajw.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_IFtlYVahHxnJbsna_o-iSw_AJz2CnRI";

// Shared data uses Supabase Realtime for change notifications.
// Manual refresh and focus refresh remain as safety fallbacks; there is no recurring full-table polling.
