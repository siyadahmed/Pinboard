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
- `006_board_sharing.sql` — create boards, invite people, and delete boards
  from the app (see §7). No data changes. Run it before deploying the app
  that uses it.

Before running a new migration against the live project, run the replay test
in `supabase/tests`.

## 7. Share a board

Everything happens in the app; no SQL needed. Signups are open, and everyone
who signs in gets their own private board.

1. **Create the board.** Open the board menu in the header and choose
   **+ New board…**. You're its owner, and it starts with one area, "General".
2. **Invite people.** In **Board settings → People**, enter their email and
   press **Invite**. Pinboard then offers to email them a sign-in link.
3. **They sign in** with that email, using the link or the sign-in page. The
   board appears in their board menu as "(shared with you)". Until then they
   show as *Invited*, and **Send link** sends another link.

The response is the same whether or not the address already has an account,
so an invite never reveals who uses Pinboard. An invite only becomes a
membership when that person signs in.

Also in **Board settings**:

- Owners can remove a member (✕), cancel an invite, or **Delete board**. To
  delete, you type the board's name. This removes the board's tasks for
  everyone on it, and you can't delete your only board.
- Members see who's on the board and can **Leave board**.

Sign-in links use Supabase's **Magic Link** email template, the same one as
the sign-in page. To make the email say "Pinboard", edit that template under
Authentication → Emails. Links count against the email rate limit in
[Rate Limits](https://supabase.com/dashboard/project/iurmlkqlasufztgtrzpf/auth/rate-limits).

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
