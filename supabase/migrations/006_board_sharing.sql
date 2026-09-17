-- Pinboard — Phase 6: create, share and delete boards from the app
--
-- Until now a second board, and inviting someone to it, meant pasting SQL.
-- This adds the database side of doing it in Board settings:
--
--   create_board(name)              any signed-in user; they become its owner
--   invite_to_board(board, email)   owners; always records a pending invite
--   list_board_members(board)       members see who's on it; owners also see invites
--   delete_board(board, typed name) owners; the name must be typed to confirm
--
-- Removing a member, leaving a board and cancelling an invite are plain
-- deletes under the existing policies, with a new guard that a board always
-- keeps an owner.
--
-- Privacy: inviting an address must not reveal whether it has a Pinboard
-- account. So an invite is always stored as pending, whoever it's for, and it
-- only becomes a membership when that person signs in to the app
-- (claim_board_invites, which the app calls on every sign-in). For the same
-- reason signing up no longer claims invites on the spot: an account created
-- by sending someone a sign-in link would otherwise show up as a member
-- straight away, while an existing account would stay pending.
--
-- Additive and safe to run on the live board: no table or data changes.
-- Contains no personal data.
--
-- Run in: https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new

-- ---------------------------------------------------------------------
-- 1. Creating a board
--
-- A new board has no owner yet, so the "members: invite" policy (owners
-- only) can't let its creator add themselves. This function does both steps
-- together. The direct-insert policy it replaces could only ever make boards
-- nobody could open, so it goes.
-- ---------------------------------------------------------------------

drop policy if exists "boards: create" on public.boards;

create or replace function public.create_board(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_name  text := btrim(coalesce(p_name, ''));
  v_board uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to create a board.';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'A board name needs 1 to 60 characters.';
  end if;
  if (select count(*) from public.board_members where user_id = v_uid and role = 'owner') >= 50 then
    raise exception 'You already own 50 boards — delete one before creating another.';
  end if;

  -- The boards_default_area trigger gives it a "General" area.
  insert into public.boards (name, created_by) values (v_name, v_uid)
  returning id into v_board;
  insert into public.board_members (board_id, user_id, role) values (v_board, v_uid, 'owner');
  return v_board;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Inviting by email
--
-- Always a pending invite, so the response is identical whether or not the
-- address has an account. The only refusals are ones the owner can already
-- see for themselves: their own address, or someone already listed as a
-- member of this board.
-- ---------------------------------------------------------------------

create or replace function public.invite_to_board(p_board uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_board_owner(p_board) then
    raise exception 'Only the board''s owner can invite people.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 254 then
    raise exception 'That doesn''t look like an email address.';
  end if;
  if v_email = (select lower(email) from auth.users where id = v_uid) then
    raise exception 'That''s your own email — you''re already on this board.';
  end if;
  if exists (
    select 1 from public.board_members m join auth.users u on u.id = m.user_id
    where m.board_id = p_board and lower(u.email) = v_email
  ) then
    raise exception '% is already on this board.', v_email;
  end if;
  if (select count(*) from public.board_invites where board_id = p_board) >= 50 then
    raise exception 'This board has 50 pending invites — cancel some first.';
  end if;

  insert into public.board_invites (board_id, email, role, invited_by)
  values (p_board, v_email, 'member', v_uid)
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Who's on a board
--
-- Email addresses live in auth.users, which the app can't read, so this
-- returns them for one board at a time. Members see the other members, as
-- they share the board's tasks anyway. Pending invites are a list of
-- addresses the owner typed in, so only owners see those.
-- ---------------------------------------------------------------------

create or replace function public.list_board_members(p_board uuid)
returns table (kind text, user_id uuid, email text, role text, is_you boolean)
language sql
security definer
set search_path = public
stable
as $$
  select * from (
    select 'member'::text, m.user_id, u.email::text, m.role, m.user_id = (select auth.uid())
    from public.board_members m
    left join auth.users u on u.id = m.user_id
    where m.board_id = p_board and public.is_board_member(p_board)
    union all
    select 'invite'::text, null::uuid, i.email, i.role, false
    from public.board_invites i
    where i.board_id = p_board and public.is_board_owner(p_board)
  ) r (kind, user_id, email, role, is_you)
  order by r.kind desc, r.role desc, lower(r.email);
$$;

-- ---------------------------------------------------------------------
-- 4. Signing up no longer claims invites (see the header)
-- ---------------------------------------------------------------------

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

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. A board always keeps an owner
--
-- Stops the last owner leaving (or being removed) and stranding the board.
-- Let the row go when the board itself is being deleted, or when the account
-- is being deleted, so neither of those gets blocked.
-- ---------------------------------------------------------------------

create or replace function public.keep_one_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'owner'
     and exists (select 1 from public.boards where id = old.board_id)
     and exists (select 1 from auth.users where id = old.user_id)
     and not exists (
       select 1 from public.board_members
       where board_id = old.board_id and role = 'owner' and user_id <> old.user_id
     ) then
    raise exception 'A board needs an owner — delete the board instead of leaving it.';
  end if;
  return old;
end;
$$;

drop trigger if exists board_members_keep_owner on public.board_members;
create trigger board_members_keep_owner
  before delete on public.board_members
  for each row execute function public.keep_one_owner();

-- ---------------------------------------------------------------------
-- 6. Deleting a board
--
-- Takes every task, area, membership and invite with it, for everyone on
-- it. Two guards: the caller has to repeat the board's exact name (so a
-- stale or mistaken id can't delete the wrong board), and nobody can delete
-- the last board they're on, which would leave them with nothing to open.
-- There's no delete policy on boards, so this is the only way to do it.
-- ---------------------------------------------------------------------

create or replace function public.delete_board(p_board uuid, p_confirm_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_name text;
begin
  select name into v_name from public.boards where id = p_board;
  if v_name is null or not public.is_board_owner(p_board) then
    raise exception 'Only the board''s owner can delete it.';
  end if;
  if btrim(coalesce(p_confirm_name, '')) <> btrim(v_name) then
    raise exception 'The name typed doesn''t match this board, so nothing was deleted.';
  end if;
  if not exists (select 1 from public.board_members where user_id = v_uid and board_id <> p_board) then
    raise exception 'This is your only board — create another one before deleting it.';
  end if;

  delete from public.boards where id = p_board;
end;
$$;

-- ---------------------------------------------------------------------
-- Only signed-in users call these; each one checks membership itself too.
-- ---------------------------------------------------------------------

revoke execute on function public.create_board(text)               from public, anon;
revoke execute on function public.invite_to_board(uuid, text)      from public, anon;
revoke execute on function public.list_board_members(uuid)         from public, anon;
revoke execute on function public.delete_board(uuid, text)         from public, anon;
grant  execute on function public.create_board(text)               to authenticated;
grant  execute on function public.invite_to_board(uuid, text)      to authenticated;
grant  execute on function public.list_board_members(uuid)         to authenticated;
grant  execute on function public.delete_board(uuid, text)         to authenticated;

-- ---------------------------------------------------------------------
-- Check: both should be 0.
-- ---------------------------------------------------------------------

select
  (select count(*) from public.boards b
    where not exists (select 1 from public.board_members m where m.board_id = b.id and m.role = 'owner')
  ) as boards_without_an_owner,
  (select count(*) from pg_policies where tablename = 'boards' and policyname = 'boards: create'
  ) as old_create_policy_left;
