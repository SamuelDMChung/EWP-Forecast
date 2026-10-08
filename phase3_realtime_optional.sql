-- EWP Management Portal Phase 3: OPTIONAL Tracker Realtime publication.
-- Run after Phase 2 migration, only if live updates across employees are wanted.
-- This makes Tracker table changes visible to authenticated subscribers under current RLS.
-- Safe to run more than once. No deletions, data conversion, or changes to Forecast tables.
do $$
declare v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'No supabase_realtime publication found; skipping live updates. Fallback refresh still works.';
    return;
  end if;
  foreach v_table in array array['tracker_work_items','tracker_settings','tracker_saved_filters'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;
