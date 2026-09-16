-- Pinboard — Phase 5: each board defines its own areas; tasks can move boards
--
-- 1. Retires 004's per-member area limits. Separate boards already keep
--    things private, and limits on top mostly repeated that at real cost.
-- 2. Replaces the fixed, app-wide area list with areas each board's owner
--    manages. A new board starts with a single "General" area.
-- 3. Makes moving a task to another board safe: its sub-tasks go with it,
--    and a task's area must belong to the board it's on.
--
-- CHANGES LIVE DATA, in one transaction. Every existing board gets the six
-- areas it has effectively had until now — YouTube, Consulting, Skill Dev,
-- Hobby / Pi, Investing, Other, in the same colours — and every task is
-- mapped onto its own board's copy. Nothing moves or changes colour. If any
-- task can't be mapped, the whole script aborts and nothing is changed.
--
-- DEPLOY ORDER: the app and connector currently on `main` read tasks.area,
-- which this drops. Run this, then merge the per-board-areas branch and
-- deploy the connector straight after. Contains no personal data.
--
-- Run in: https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new

-- =====================================================================
-- 1. Retire per-member area limits (004)
-- =====================================================================

drop policy if exists "tasks: visible areas" on public.tasks;
drop policy if exists "tasks: board members" on public.tasks;
create policy "tasks: board members" on public.tasks
  for all to authenticated
  using (public.is_board_member(board_id))
  with check (public.is_board_member(board_id));

drop policy if exists "members: owner update" on public.board_members;

drop trigger if exists tasks_sync_subtask_area on public.tasks;
drop trigger if exists tasks_cascade_parent_area on public.tasks;
drop function if exists public.sync_subtask_area();
drop function if exists public.cascade_parent_area();
drop function if exists public.can_see_area(uuid, text);

alter table public.board_members drop constraint if exists board_members_visible_areas_valid;
alter table public.board_invites drop constraint if exists board_invites_visible_areas_valid;
alter table public.board_members drop column if exists visible_areas;
alter table public.board_invites drop column if exists visible_areas;

-- 004's versions of these two functions write visible_areas; left in place,
-- every new signup would fail on the column dropped just above.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_board uuid;
begin
  insert into public.boards (name, created_by)
  values ('My Board', new.id)
  returning id into new_board;

  insert into public.board_members (board_id, user_id, role)
  values (new_board, new.id, 'owner');

  insert into public.board_members (board_id, user_id, role)
  select i.board_id, new.id, i.role
  from public.board_invites i
  where lower(i.email) = lower(new.email)
  on conflict (board_id, user_id) do nothing;

  delete from public.board_invites where lower(email) = lower(new.email);

  return new;
end;
$$;

create or replace function public.claim_board_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer;
begin
  select email into v_email from auth.users where id = (select auth.uid());
  if v_email is null then
    return 0;
  end if;

  insert into public.board_members (board_id, user_id, role)
  select i.board_id, (select auth.uid()), i.role
  from public.board_invites i
  where lower(i.email) = lower(v_email)
  on conflict (board_id, user_id) do nothing;
  get diagnostics v_count = row_count;

  delete from public.board_invites where lower(email) = lower(v_email);
  return v_count;
end;
$$;

-- =====================================================================
-- 2. Areas belong to a board
-- =====================================================================

-- Colours are keys into a fixed set of Chart Room inks, not free hex values,
-- so every area stays legible on the paper ground and the theme can retune
-- an ink without touching data.
create table if not exists public.board_areas (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards(id) on delete cascade,
  name       text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  color      text not null default 'slate'
             check (color in ('madder','sepia','brass','olive','verdigris','indigo','murex','slate')),
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  -- Target for the tasks foreign key below, which pins a task's area to
  -- the board the task is actually on.
  unique (id, board_id)
);

create unique index if not exists board_areas_board_name_idx on public.board_areas (board_id, lower(name));
create index if not exists board_areas_board_position_idx on public.board_areas (board_id, position);

alter table public.board_areas enable row level security;

drop policy if exists "areas: members read"   on public.board_areas;
drop policy if exists "areas: owners add"     on public.board_areas;
drop policy if exists "areas: owners edit"    on public.board_areas;
drop policy if exists "areas: owners delete"  on public.board_areas;

create policy "areas: members read" on public.board_areas
  for select to authenticated using (public.is_board_member(board_id));
create policy "areas: owners add" on public.board_areas
  for insert to authenticated with check (public.is_board_owner(board_id));
create policy "areas: owners edit" on public.board_areas
  for update to authenticated
  using (public.is_board_owner(board_id)) with check (public.is_board_owner(board_id));
create policy "areas: owners delete" on public.board_areas
  for delete to authenticated using (public.is_board_owner(board_id));

-- Give every existing board the six areas the app has been showing it.
insert into public.board_areas (board_id, name, color, position)
select b.id, l.name, l.color, l.position
from public.boards b
cross join (values
  ('YouTube',    'madder',    0),
  ('Consulting', 'indigo',    1),
  ('Skill Dev',  'murex',     2),
  ('Hobby / Pi', 'verdigris', 3),
  ('Investing',  'brass',     4),
  ('Other',      'slate',     5)
) as l(name, color, position)
where not exists (select 1 from public.board_areas a where a.board_id = b.id);

-- Point every task at its board's copy of its old area, then drop the old
-- text column. Guarded so the script is safe to re-run.
alter table public.tasks add column if not exists area_id uuid;

do $$
declare
  v_unmapped bigint;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tasks' and column_name = 'area') then

    update public.tasks t
       set area_id = a.id
      from public.board_areas a,
           (values ('youtube','YouTube'), ('consulting','Consulting'), ('skill','Skill Dev'),
                   ('hobby','Hobby / Pi'), ('invest','Investing'), ('other','Other')) as m(key, name)
     where t.area_id is null
       and a.board_id = t.board_id
       and m.key = t.area
       and a.name = m.name;

    -- Anything with an unrecognised area lands in its board's Other.
    update public.tasks t
       set area_id = a.id
      from public.board_areas a
     where t.area_id is null
       and a.board_id = t.board_id
       and a.name = 'Other';
  end if;

  select count(*) into v_unmapped from public.tasks where area_id is null;
  if v_unmapped > 0 then
    raise exception 'Aborting: % task(s) could not be given an area. Nothing has been changed.', v_unmapped;
  end if;
end $$;

alter table public.tasks alter column area_id set not null;

alter table public.tasks drop constraint if exists tasks_area_on_board_fk;
alter table public.tasks add constraint tasks_area_on_board_fk
  foreign key (area_id, board_id) references public.board_areas (id, board_id);

create index if not exists tasks_area_idx on public.tasks (area_id);

alter table public.tasks drop column if exists area;

-- Every new board starts with one area, so it's usable before the owner has
-- set any up.
create or replace function public.board_default_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.board_areas (board_id, name, color, position)
  values (new.id, 'General', 'slate', 0);
  return null;
end;
$$;

drop trigger if exists boards_default_area on public.boards;
create trigger boards_default_area
  after insert on public.boards
  for each row execute function public.board_default_area();

-- A board always keeps at least one area — otherwise nothing could be added
-- to it. Deleting the board itself is still allowed: by the time its areas
-- are removed by the cascade, the board row is already gone.
create or replace function public.keep_one_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.boards where id = old.board_id)
     and not exists (select 1 from public.board_areas where board_id = old.board_id and id <> old.id) then
    raise exception 'A board needs at least one area.';
  end if;
  return old;
end;
$$;

drop trigger if exists board_areas_keep_one on public.board_areas;
create trigger board_areas_keep_one
  before delete on public.board_areas
  for each row execute function public.keep_one_area();

-- Delete an area, moving its tasks to another area on the same board first.
-- Runs as the caller, so the normal policies apply: only an owner can do it.
create or replace function public.delete_board_area(p_area uuid, p_move_to uuid default null)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_board        uuid;
  v_target_board uuid;
  v_count        integer;
begin
  select board_id into v_board from public.board_areas where id = p_area;
  if v_board is null then
    raise exception 'That area no longer exists.';
  end if;
  if not public.is_board_owner(v_board) then
    raise exception 'Only a board owner can delete areas.';
  end if;

  select count(*) into v_count from public.tasks where area_id = p_area;
  if v_count > 0 then
    if p_move_to is null then
      raise exception 'This area still has % task(s) — choose an area to move them to.', v_count;
    end if;
    select board_id into v_target_board from public.board_areas where id = p_move_to;
    if v_target_board is distinct from v_board or p_move_to = p_area then
      raise exception 'Tasks can only be moved to a different area on the same board.';
    end if;
    -- Top-level tasks only: their sub-tasks follow them automatically.
    update public.tasks set area_id = p_move_to where area_id = p_area and parent_id is null;
  end if;

  delete from public.board_areas where id = p_area;
  return v_count;
end;
$$;

revoke all on function public.delete_board_area(uuid, uuid) from public, anon;
grant execute on function public.delete_board_area(uuid, uuid) to authenticated;

-- =====================================================================
-- 3. A sub-task always lives on its parent's board, in its parent's area
--
-- Moving a task to another board is a single update of its board and area;
-- its sub-tasks follow automatically. Moving needs membership of both boards:
-- the policy's USING checks the board it's leaving, WITH CHECK the board it
-- arrives on. The foreign key above rejects an area from the wrong board.
-- =====================================================================

create or replace function public.subtask_follows_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null then
    select p.board_id, p.area_id into new.board_id, new.area_id
    from public.tasks p where p.id = new.parent_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_subtask_follows_parent on public.tasks;
create trigger tasks_subtask_follows_parent
  before insert or update of board_id, area_id, parent_id on public.tasks
  for each row execute function public.subtask_follows_parent();

create or replace function public.children_follow_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks
     set board_id = new.board_id, area_id = new.area_id
   where parent_id = new.id
     and (board_id is distinct from new.board_id or area_id is distinct from new.area_id);
  return null;
end;
$$;

drop trigger if exists tasks_children_follow_parent on public.tasks;
create trigger tasks_children_follow_parent
  after update of board_id, area_id on public.tasks
  for each row
  when (new.parent_id is null
        and (old.board_id is distinct from new.board_id or old.area_id is distinct from new.area_id))
  execute function public.children_follow_parent();

-- =====================================================================
-- 4. Verify (expect: tasks_without_area = 0, boards_without_areas = 0)
-- =====================================================================

select
  (select count(*) from public.tasks)                                  as total_tasks,
  (select count(*) from public.tasks where area_id is null)            as tasks_without_area,
  (select count(*) from public.board_areas)                            as areas,
  (select count(*) from public.boards b
     where not exists (select 1 from public.board_areas a where a.board_id = b.id)) as boards_without_areas;
