// Browser-safe Supabase connection settings.
// IMPORTANT: Only use a Supabase publishable/anon key here. Never put a secret/service-role key in GitHub Pages.
export const SUPABASE_URL = "https://dmlodguzwgsbbirptajw.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_IFtlYVahHxnJbsna_o-iSw_AJz2CnRI";

// Team refresh interval. The app also refreshes after every write and when the window regains focus.
export const AUTO_REFRESH_MS = 10000;
