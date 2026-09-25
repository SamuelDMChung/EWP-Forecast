-- EWP Material Forecast V0.19
-- Run this once in Supabase SQL Editor BEFORE deploying the V0.19 frontend.
-- This migration is idempotent and includes the V0.16/V0.17 inventory and purchasing schema.
-- V0.19 replaces level-wide Spruce status with quantity-based Spruce order batches.

begin;

-- V0.16 planning fields.
alter table public.projects
  add column if not exists project_type text not null default 'multi';

alter table public.levels
  add column if not exists workflow_status text not null default 'forecast',
  add column if not exists is_active boolean not null default true;

alter table public.materials
  add column if not exists is_active boolean not null default true;

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

-- Open incoming material. V0.17 keeps this table as the line-item ledger so
-- existing V0.16 manual entries continue to work.
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

-- V0.17 purchase-order header. One PO can contain many incoming material rows.
create table if not exists public.purchase_orders (
  id uuid primary key,
  po_number text not null,
  order_date date,
  expected_date date not null,
  source_file_name text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1)
);

create unique index if not exists purchase_orders_po_number_key
  on public.purchase_orders (lower(po_number));
create index if not exists purchase_orders_expected_date_idx
  on public.purchase_orders (expected_date);

-- Link imported PO lines to their header and retain the original length/package
-- detail so the app can aggregate by material without throwing away PO detail.
alter table public.incoming_orders
  add column if not exists purchase_order_id uuid references public.purchase_orders(id) on delete cascade,
  add column if not exists length_breakdown jsonb not null default '[]'::jsonb;

create index if not exists incoming_orders_purchase_order_id_idx
  on public.incoming_orders (purchase_order_id);

-- Signed-in-user access, matching the existing app model.
alter table public.inventory_materials enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.incoming_orders enable row level security;

grant select, insert, update, delete on public.inventory_materials to authenticated;
grant select, insert, update, delete on public.purchase_orders to authenticated;
grant select, insert, update, delete on public.incoming_orders to authenticated;

drop policy if exists "authenticated inventory access" on public.inventory_materials;
create policy "authenticated inventory access"
  on public.inventory_materials
  for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "authenticated purchase order access" on public.purchase_orders;
create policy "authenticated purchase order access"
  on public.purchase_orders
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

-- Realtime publication for all V0.16/V0.17 inventory and purchasing tables.
do $$
declare
  t text;
begin
  foreach t in array array['inventory_materials','purchase_orders','incoming_orders']
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



-- V0.19 Spruce order batches. A batch can be partially populated by material,
-- but once delivered the whole batch changes state together.
create table if not exists public.spruce_orders (
  id uuid primary key,
  level_id uuid not null references public.levels(id) on delete cascade,
  entered_at timestamptz not null default now(),
  note text,
  delivered_at timestamptz,
  delivery_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1)
);

create table if not exists public.spruce_order_items (
  id uuid primary key,
  spruce_order_id uuid not null references public.spruce_orders(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete cascade,
  material_name text not null,
  quantity_lf numeric not null check (quantity_lf > 0),
  created_at timestamptz not null default now()
);

create index if not exists spruce_orders_level_id_idx
  on public.spruce_orders (level_id);
create index if not exists spruce_orders_delivered_at_idx
  on public.spruce_orders (delivered_at);
create index if not exists spruce_order_items_order_id_idx
  on public.spruce_order_items (spruce_order_id);
create index if not exists spruce_order_items_material_id_idx
  on public.spruce_order_items (material_id);

alter table public.spruce_orders enable row level security;
alter table public.spruce_order_items enable row level security;

grant select, insert, update, delete on public.spruce_orders to authenticated;
grant select, insert, update, delete on public.spruce_order_items to authenticated;

drop policy if exists "authenticated spruce order access" on public.spruce_orders;
create policy "authenticated spruce order access"
  on public.spruce_orders
  for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "authenticated spruce order item access" on public.spruce_order_items;
create policy "authenticated spruce order item access"
  on public.spruce_order_items
  for all
  to authenticated
  using (true)
  with check (true);

-- Guard against two users committing more LF than a material can support.
create or replace function public.validate_spruce_order_item_quantity()
returns trigger
language plpgsql
as $$
declare
  v_required numeric := 0;
  v_excluded numeric := 0;
  v_legacy_delivered numeric := 0;
  v_other_spruce numeric := 0;
begin
  -- Lock the material row so two users cannot both validate against the same
  -- stale remaining quantity and over-commit it at the same time.
  select coalesce(original_lf, 0), coalesce(excluded_lf, 0)
    into v_required, v_excluded
  from public.materials
  where id = new.material_id
  for update;

  if not found then
    raise exception 'Material % no longer exists.', new.material_id;
  end if;

  select coalesce(sum(delivered_lf), 0)
    into v_legacy_delivered
  from public.deliveries
  where material_id = new.material_id;

  select coalesce(sum(quantity_lf), 0)
    into v_other_spruce
  from public.spruce_order_items
  where material_id = new.material_id
    and id <> new.id;

  if v_excluded + v_legacy_delivered + v_other_spruce + new.quantity_lf > v_required + 0.0001 then
    raise exception 'Spruce quantity exceeds remaining forecast for material %.', new.material_id;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_spruce_order_item_quantity_trigger on public.spruce_order_items;
create trigger validate_spruce_order_item_quantity_trigger
before insert or update of material_id, quantity_lf
on public.spruce_order_items
for each row execute function public.validate_spruce_order_item_quantity();

-- Also prevent a revision from reducing required LF below material already
-- delivered, excluded, or committed to a Spruce batch.
create or replace function public.validate_material_required_lf()
returns trigger
language plpgsql
as $$
declare
  v_legacy_delivered numeric := 0;
  v_spruce numeric := 0;
begin
  if new.original_lf is not distinct from old.original_lf
     and new.excluded_lf is not distinct from old.excluded_lf then
    return new;
  end if;

  select coalesce(sum(delivered_lf), 0)
    into v_legacy_delivered
  from public.deliveries
  where material_id = new.id;

  select coalesce(sum(quantity_lf), 0)
    into v_spruce
  from public.spruce_order_items
  where material_id = new.id;

  if coalesce(new.excluded_lf, 0) + v_legacy_delivered + v_spruce > coalesce(new.original_lf, 0) + 0.0001 then
    raise exception 'Required LF cannot be less than delivered, excluded, and Spruce-committed LF for material %.', new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_material_required_lf_trigger on public.materials;
create trigger validate_material_required_lf_trigger
before update of original_lf, excluded_lf
on public.materials
for each row execute function public.validate_material_required_lf();

-- Convert any V0.16/V0.18 whole-level "In Spruce" status into one open
-- Spruce batch containing the level's current outstanding quantities. This runs
-- only once in practice because migrated levels are reset to workflow_status=forecast.
do $$
declare
  lvl record;
  batch_id uuid;
begin
  for lvl in
    select id, updated_at
    from public.levels
    where workflow_status = 'spruce'
  loop
    batch_id := gen_random_uuid();

    insert into public.spruce_orders (id, level_id, entered_at, note, version)
    values (batch_id, lvl.id, coalesce(lvl.updated_at, now()), 'Migrated from pre-V0.19 In Spruce status', 1);

    insert into public.spruce_order_items (id, spruce_order_id, material_id, material_name, quantity_lf)
    select
      gen_random_uuid(),
      batch_id,
      m.id,
      m.material_name,
      greatest(
        coalesce(m.original_lf, 0)
        - coalesce(m.excluded_lf, 0)
        - coalesce(d.delivered_lf, 0),
        0
      )
    from public.materials m
    left join (
      select material_id, sum(delivered_lf) as delivered_lf
      from public.deliveries
      group by material_id
    ) d on d.material_id = m.id
    where m.level_id = lvl.id
      and coalesce(m.is_active, true) = true
      and greatest(
        coalesce(m.original_lf, 0)
        - coalesce(m.excluded_lf, 0)
        - coalesce(d.delivered_lf, 0),
        0
      ) > 0;

    if not exists (
      select 1 from public.spruce_order_items where spruce_order_id = batch_id
    ) then
      delete from public.spruce_orders where id = batch_id;
    end if;
  end loop;

  update public.levels
  set workflow_status = 'forecast',
      updated_at = now(),
      version = version + 1
  where workflow_status = 'spruce';
end $$;

-- Realtime publication for the new Spruce tables.
do $$
declare
  t text;
begin
  foreach t in array array['spruce_orders','spruce_order_items']
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
