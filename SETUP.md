# Pinboard — setup runbook

Everything here is done in the Supabase dashboard or your Google account.
Direct links are for project `iurmlkqlasufztgtrzpf`.

All the auth settings live under the **Authentication** item in the left
sidebar — *not* under Project Settings, which is where they used to be.

| What | Link |
|---|---|
| SQL Editor | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/sql/new |
| SMTP | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/smtp |
| URL Configuration | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/url-configuration |
| Rate limits | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/rate-limits |
| Users | https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/users |

---

## 1. Run the additive migration

Paste `supabase/migrations/001_boards_additive.sql` into the SQL Editor and
run it. This is safe on the live board: it only adds tables and columns, and
leaves the existing anon policy alone.

## 2. Gmail as the mail sender

First create a Google **App Password** — an ordinary account password will
not work, and the option only appears once 2-Step Verification is on:

Google Account → Security → 2-Step Verification → App passwords.
You get a 16-character code.

Then on the **SMTP** page above, enable custom SMTP:

| Field | Value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | your Gmail address |
| Password | the 16-character App Password |
| Sender email | the same Gmail address |
| Sender name | `Pinboard` |

Sender email has to be that same Gmail address. Gmail rewrites `From` to
whichever account authenticated, so anything else either fails or silently
sends as you anyway.

Then on the **Rate limits** page, raise the emails-per-hour cap. The default
is sized for Supabase's built-in test sender and is low enough to lock you
out of your own sign-ins while testing.

## 3. URL configuration

On the **URL Configuration** page:

- **Site URL**: `https://siyadahmed.github.io/Pinboard/`
- **Redirect URLs**: add both of
  - `https://siyadahmed.github.io/Pinboard/**`
  - `http://localhost:8744/index.html` (local testing)

A magic link whose redirect isn't on this list silently falls back to the
Site URL, which looks like the link "not working".

## 4. Sign in once

Open the site, enter your email, click the link in the inbox. This creates
your `auth.users` row, and the signup trigger from step 1 creates your board.

Confirm it worked on the **Users** page — you should see your email listed.

## 5. Run the cutover

Paste `supabase/migrations/002_boards_cutover.sql` and run it. It adopts
every existing task into your board and revokes public access.

It aborts with a clear error if step 4 hasn't happened, rather than
half-migrating.

Expected output: `anon_policies = 0`, `orphan_tasks = 0`, and your full task
count.

## 6. Later migrations

Run these in order, each in the SQL Editor. All are safe to re-run.

- `003_board_invites.sql` — invite someone to a board by email, before or
  after they've signed up.
- `004_member_area_visibility.sql` — superseded by 005; still run it so the
  history replays cleanly.
- `005_per_board_areas.sql` — each board manages its own areas; tasks can move
  between boards. **Changes live data**: existing boards keep their six areas
  and every task keeps its area. Deploy the matching app and connector straight
  after it — they read the new columns.

Before running a new migration against the live project, run the replay test
in `supabase/tests`.

## 7. Share a board

Signups are open: anyone who signs in gets their own private board. To share
a board as well, create it and invite them. Fill in the placeholders and run
this; nothing in it is saved to the repo. It works whether or not they've
signed up yet.

```sql
do $$
declare
  v_owner_email  text := 'YOUR-EMAIL';
  v_member_email text := 'THEIR-EMAIL';
  v_board_name   text := 'Household';
  v_owner uuid; v_member uuid; v_board uuid;
begin
  select id into v_owner from auth.users where lower(email) = lower(v_owner_email);
  if v_owner is null then raise exception 'No account for %', v_owner_email; end if;

  select b.id into v_board from public.boards b
  join public.board_members m on m.board_id = b.id and m.user_id = v_owner and m.role = 'owner'
  where b.name = v_board_name limit 1;
  if v_board is null then
    insert into public.boards (name, created_by) values (v_board_name, v_owner) returning id into v_board;
    insert into public.board_members (board_id, user_id, role) values (v_board, v_owner, 'owner');
  end if;

  select id into v_member from auth.users where lower(email) = lower(v_member_email);
  if v_member is not null then
    insert into public.board_members (board_id, user_id, role)
    values (v_board, v_member, 'member') on conflict (board_id, user_id) do nothing;
    raise notice 'Added % to %', v_member_email, v_board_name;
  else
    insert into public.board_invites (board_id, email, role, invited_by)
    values (v_board, v_member_email, 'member', v_owner) on conflict (board_id, lower(email)) do nothing;
    raise notice 'Invited % — they join % when they sign up', v_member_email, v_board_name;
  end if;
end $$;
```

A new board starts with one area, "General". Its owner sets up the rest in
**Board settings**.

## 8. The Claude connector

The connector (`mcp-server/`) reads and writes with a Supabase secret key
scoped in code to one account's boards. It needs two Worker secrets beyond
`OWNER_PASSWORD`:

1. In **Settings → API Keys**, create a secret key (e.g. `pinboard-mcp`) so it
   can be revoked on its own.
2. From `mcp-server/`:
   `npx wrangler secret put SUPABASE_SECRET_KEY` and
   `npx wrangler secret put MCP_USER_EMAIL`, then `npx wrangler deploy`.

See `mcp-server/README.md` for how access is enforced.
