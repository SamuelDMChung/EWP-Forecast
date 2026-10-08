-- EWP Management Portal V1.0 — Phase 2
-- Apply AFTER the EWP Forecast v0.26 cumulative migration. Run once in Supabase SQL Editor.
-- Non-destructive: existing forecast projects, levels, deliveries and stock are retained.
begin;

-- Existing Forecast projects are the single authoritative project register.
-- Tracker-only fields do not modify Forecast's existing project_type constraint.
alter table public.projects
  add column if not exists tracker_phase text,
  add column if not exists tracker_project_type text,
  add column if not exists tracker_project_type_other text,
  add column if not exists tracker_large_tji text,
  add column if not exists tracker_apl_required text,
  add column if not exists tracker_date_submitted date,
  add column if not exists tracker_due_date date;

-- A project number must refer to one shared project record (including PDF imports).
-- Resolve any historical duplicates before applying this migration, rather than
-- silently deleting or overwriting Forecast records.
do $$
begin
  if exists (select 1 from public.projects where trim(coalesce(project_number,'')) <> ''
    group by upper(trim(project_number)) having count(*) > 1) then
    raise exception 'Duplicate project numbers exist. Resolve them before installing Phase 2 (no data was deleted).';
  end if;
end $$;
create unique index if not exists ewp_shared_project_number_unique
  on public.projects (upper(trim(project_number)))
  where trim(coalesce(project_number,'')) <> '';

create table if not exists public.tracker_work_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task text not null default '',
  assignee text not null default '',
  due_date date,
  status text not null default 'queue' check (status in ('queue','in_progress','done')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tracker_work_items_project_idx on public.tracker_work_items(project_id);

create table if not exists public.tracker_settings (
  id text primary key default 'global' check (id = 'global'),
  sales jsonb not null default '[]'::jsonb,
  assignees jsonb not null default '[]'::jsonb,
  tasks jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.tracker_settings (id) values ('global') on conflict do nothing;
-- Restore any known sales names from the Forecast project registry, without
-- overwriting a pre-existing manually curated settings list.
update public.tracker_settings
set sales=(select coalesce(jsonb_agg(value order by value),'[]'::jsonb)
           from (select distinct trim(sales) as value from public.projects
                 where trim(coalesce(sales,'')) <> '') t)
where id='global' and sales='[]'::jsonb;

create table if not exists public.tracker_saved_filters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  search text not null default '',
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.tracker_number_sequences (
  yy text primary key check (yy ~ '^[0-9]{2}$'),
  last_number integer not null check (last_number between 0 and 999)
);
-- Existing Forecast numbers also count toward the high-water mark.
insert into public.tracker_number_sequences (yy, last_number)
select substring(upper(trim(project_number)) from 3 for 2),
       max(right(upper(trim(project_number)),3)::integer)
from public.projects
where upper(trim(project_number)) ~ '^TC[0-9]{5}$'
group by substring(upper(trim(project_number)) from 3 for 2)
on conflict (yy) do update set last_number = greatest(tracker_number_sequences.last_number, excluded.last_number);

-- Existing PDF projects without tracker tasks appear in the Tracker queue.
insert into public.tracker_work_items(project_id, task, status)
select p.id, 'Assign task', 'queue' from public.projects p
where not exists (select 1 from public.tracker_work_items w where w.project_id=p.id);

create or replace function public.tracker_initialize_work_item()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  insert into public.tracker_work_items(project_id,task,status)
    values (new.id,'Assign task','queue');
  return new;
end; $$;
drop trigger if exists tracker_project_work_item on public.projects;
create trigger tracker_project_work_item after insert on public.projects
  for each row execute function public.tracker_initialize_work_item();

-- RLS follows the same shared authenticated-team model as Forecast.
-- NOTE: all authenticated company users with app accounts share these data.
do $$ declare t text; begin
  foreach t in array array['tracker_work_items','tracker_settings','tracker_saved_filters','tracker_number_sequences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists "authenticated team access" on public.%I',t);
    execute format('create policy "authenticated team access" on public.%I for all to authenticated using (true) with check (true)',t);
  end loop;
end $$;

-- Project insert/update + work items are one transaction, with a server-side
-- high-water numbering register to prevent duplicate numbers across users.
create or replace function public.tracker_save_project(p_project jsonb, p_work_items jsonb, p_expected_version integer default null)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  v_id uuid;
  v_number text;
  v_yy text;
  v_suffix integer;
  v_current_version integer;
  v_row record;
  v_item jsonb;
  v_item_id uuid;
  v_status text;
  v_type text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  v_number := upper(trim(coalesce(p_project->>'projectNumber','')));
  if nullif(p_project->>'id','') is null and v_number !~ '^TC[0-9]{5}$' then
    raise exception 'New Tracker projects must use TCYYXXX';
  end if;
  if v_number ~ '^TC[0-9]{5}$' then
    v_yy := substring(v_number from 3 for 2);
    v_suffix := right(v_number,3)::integer;
    if v_suffix < 1 then raise exception 'Project number suffix must be at least 001'; end if;
    perform pg_advisory_xact_lock(hashtext('ewp_tracker_sequence_'||v_yy));
  end if;
  -- Frontend supplies selected number; the unique index protects simultaneous writes.
  if coalesce((p_project->>'autoNumber')::boolean,false) and nullif(p_project->>'id','') is null then
    select greatest(coalesce((select last_number from public.tracker_number_sequences where yy=v_yy),0),
      coalesce((select max(right(upper(trim(project_number)),3)::integer) from public.projects
        where upper(trim(project_number)) ~ ('^TC'||v_yy||'[0-9]{3}$')),0))+1
      into v_suffix;
    if v_suffix > 999 then raise exception 'TC number sequence is full for this year'; end if;
    v_number := 'TC'||v_yy||lpad(v_suffix::text,3,'0');
  end if;
  v_type := case when p_project->>'projectType' = 'SFD' then 'sfd' else 'multi' end;
  if nullif(p_project->>'id','') is null then
    v_id := gen_random_uuid();
    insert into public.projects
      (id,project_number,revision,address_project_name,customer,sales,project_type,
       tracker_phase,tracker_project_type,tracker_project_type_other,tracker_large_tji,
       tracker_apl_required,tracker_date_submitted,tracker_due_date,version)
    values
      (v_id,v_number,null,coalesce(p_project->>'address',''),coalesce(p_project->>'customer',''),
       coalesce(p_project->>'sales',''),v_type,p_project->>'phase',p_project->>'projectType',
       p_project->>'projectTypeOther',p_project->>'largeTji',p_project->>'aplRequired',
       nullif(p_project->>'dateSubmitted','')::date,nullif(p_project->>'dueDate','')::date,1);
  else
    v_id := (p_project->>'id')::uuid;
    select version into v_current_version from public.projects where id=v_id for update;
    if not found then raise exception 'Project not found'; end if;
    if exists(select 1 from public.levels where project_id=v_id)
       and (select upper(trim(project_number)) from public.projects where id=v_id) <> v_number then
      raise exception 'Project number is linked to EWP levels. Keep the number unchanged to preserve PDF matching.';
    end if;
    if v_yy is null and (select upper(trim(project_number)) from public.projects where id=v_id) <> v_number then
      raise exception 'Imported PDF project numbers cannot be changed in Tracker';
    end if;
    if p_expected_version is null or v_current_version <> p_expected_version then
      raise exception 'This project changed in another session. Refresh and try again.';
    end if;
    update public.projects set project_number=v_number, address_project_name=coalesce(p_project->>'address',''),
      customer=coalesce(p_project->>'customer',''), sales=coalesce(p_project->>'sales',''),
      project_type=case when exists (select 1 from public.levels where project_id=v_id) then project_type else v_type end, tracker_phase=p_project->>'phase',tracker_project_type=p_project->>'projectType',
      tracker_project_type_other=p_project->>'projectTypeOther',tracker_large_tji=p_project->>'largeTji',
      tracker_apl_required=p_project->>'aplRequired',
      tracker_date_submitted=nullif(p_project->>'dateSubmitted','')::date,
      tracker_due_date=nullif(p_project->>'dueDate','')::date,
      updated_at=now(), version=version+1 where id=v_id;
  end if;
  if v_yy is not null then
    insert into public.tracker_number_sequences(yy,last_number) values (v_yy,v_suffix)
      on conflict(yy) do update set last_number=greatest(tracker_number_sequences.last_number,excluded.last_number);
  end if;
  delete from public.tracker_work_items where project_id=v_id;
  if jsonb_typeof(p_work_items) <> 'array' then raise exception 'Work items must be an array'; end if;
  for v_item in select value from jsonb_array_elements(p_work_items) loop
    v_item_id := coalesce(nullif(v_item->>'id','')::uuid,gen_random_uuid());
    v_status := coalesce(v_item->>'status','queue');
    if v_status not in ('queue','in_progress','done') then raise exception 'Invalid work item status'; end if;
    insert into public.tracker_work_items(id,project_id,task,assignee,due_date,status,started_at,completed_at,created_at,updated_at)
      values(v_item_id,v_id,coalesce(v_item->>'task',''),coalesce(v_item->>'assignee',''),
       nullif(v_item->>'dueDate','')::date,v_status,
       nullif(v_item->>'startedAt','')::timestamptz,nullif(v_item->>'completedAt','')::timestamptz,
       coalesce(nullif(v_item->>'createdAt','')::timestamptz,now()),now());
  end loop;
  return jsonb_build_object('id',v_id,'project_number',v_number);
end; $$;

grant execute on function public.tracker_save_project(jsonb,jsonb,integer) to authenticated;

create or replace function public.tracker_move_work_item(p_id uuid,p_status text)
returns void language plpgsql security invoker set search_path=public as $$
declare v_project_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_status not in ('queue','in_progress','done') then raise exception 'Invalid status'; end if;
  select project_id into v_project_id from public.tracker_work_items where id=p_id for update;
  if v_project_id is null then raise exception 'Work item no longer exists'; end if;
  update public.tracker_work_items set status=p_status, updated_at=now(),
    started_at=case when p_status='in_progress' then coalesce(started_at,now()) else started_at end,
    completed_at=case when p_status='done' then now() else null end
    where id=p_id;
  update public.projects set updated_at=now(),version=version+1 where id=v_project_id;
end; $$;
grant execute on function public.tracker_move_work_item(uuid,text) to authenticated;

-- Do not delete Forecast records with levels; deleting a Tracker-only record is allowed.
create or replace function public.tracker_delete_project(p_id uuid,p_expected_version integer)
returns void language plpgsql security invoker set search_path=public as $$
declare v_version integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select version into v_version from public.projects where id=p_id for update;
  if v_version is null or v_version<>p_expected_version then raise exception 'Project changed. Refresh and try again.'; end if;
  if exists(select 1 from public.levels where project_id=p_id) then
    raise exception 'This project has EWP forecast levels. Remove them in Forecast first; Tracker cannot delete delivery history.';
  end if;
  delete from public.projects where id=p_id;
end; $$;
grant execute on function public.tracker_delete_project(uuid,integer) to authenticated;

-- Existing project numbering must survive deletion and new numbers from PDF import.
create or replace function public.tracker_next_number(p_yy text)
returns integer language sql stable security invoker set search_path=public as $$
  select greatest(coalesce((select last_number from public.tracker_number_sequences where yy=p_yy),0),
    coalesce((select max(right(upper(trim(project_number)),3)::integer) from public.projects
      where upper(trim(project_number)) ~ ('^TC'||p_yy||'[0-9]{3}$')),0))+1;
$$;
grant execute on function public.tracker_next_number(text) to authenticated;

-- All records are shared using RLS; old Forecast functions/policies are untouched.
commit;
