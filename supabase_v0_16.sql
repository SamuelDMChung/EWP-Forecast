-- EWP Material Forecast V0.16
-- Run this once in Supabase SQL Editor BEFORE deploying the V0.16 frontend.
-- It preserves existing project/delivery data and adds planning, archival,
-- inventory and incoming-material support.

begin;

-- Project / package planning fields.
alter table public.projects
  add column if not exists project_type text not null default 'multi';

alter table public.levels
  add column if not exists workflow_status text not null default 'forecast',
  add column if not exists is_active boolean not null default true;

alter table public.materials
  add column if not exists is_active boolean not null default true;

-- Keep values constrained to the states understood by the V0.16 UI.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_project_type_valid'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_project_type_valid
      check (project_type in ('multi', 'sfd'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'levels_workflow_status_valid'
      and conrelid = 'public.levels'::regclass
  ) then
    alter table public.levels
      add constraint levels_workflow_status_valid
      check (workflow_status in ('forecast', 'spruce'));
  end if;
end $$;

-- Current physical stock / purchasing settings by material.
create table if not exists public.inventory_materials (
  id uuid primary key,
  material_name text not null,
  on_hand_lf numeric not null default 0 check (on_hand_lf >= 0),
  lead_time_weeks integer not null default 6 check (lead_time_weeks >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1)
);

create unique index if not exists inventory_materials_material_name_key
  on public.inventory_materials (lower(material_name));

-- Open mill / transfer material already ordered but not yet fully received.
create table if not exists public.incoming_orders (
  id uuid primary key,
  material_name text not null,
  quantity_lf numeric not null check (quantity_lf > 0),
  received_lf numeric not null default 0,
  expected_date date not null,
  reference text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1),
  constraint incoming_orders_received_lf_valid
    check (received_lf >= 0 and received_lf <= quantity_lf)
);

create index if not exists incoming_orders_expected_date_idx
  on public.incoming_orders (expected_date);
create index if not exists incoming_orders_material_name_idx
  on public.incoming_orders (lower(material_name));

-- Match the existing app's signed-in-user model.
alter table public.inventory_materials enable row level security;
alter table public.incoming_orders enable row level security;

grant select, insert, update, delete on public.inventory_materials to authenticated;
grant select, insert, update, delete on public.incoming_orders to authenticated;

drop policy if exists "authenticated inventory access" on public.inventory_materials;
create policy "authenticated inventory access"
  on public.inventory_materials
  for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "authenticated incoming access" on public.incoming_orders;
create policy "authenticated incoming access"
  on public.incoming_orders
  for all
  to authenticated
  using (true)
  with check (true);

-- Publish the new tables for the same Realtime workflow as projects/deliveries.
do $$
declare
  t text;
begin
  foreach t in array array['inventory_materials','incoming_orders']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

commit;
