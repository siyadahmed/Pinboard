// Replays Pinboard's migration history on a real Postgres (PGlite), then
// applies 005 and 006 and checks data mapping, access rules, areas and sharing.
const fs = require("fs");
const path = require("path");
const { PGlite } = require("@electric-sql/pglite");

const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

const SIYAD = "11111111-1111-1111-1111-111111111111";
const WIFE = "22222222-2222-2222-2222-222222222222";
const LATER = "33333333-3333-3333-3333-333333333333";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  // Run fn as a signed-in Supabase user (role authenticated, auth.uid() = uid).
  async function as(uid, fn) {
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    }
  }
  async function fails(fn) {
    try {
      await fn();
      return null;
    } catch (e) {
      return e.message;
    }
  }

  // ---- Supabase stand-ins --------------------------------------------
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create role anon nologin;
    create role authenticated nologin;
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  try {
    await db.exec(`create publication supabase_realtime;`);
  } catch (e) {
    console.log("  (publication unsupported here; stubbing pg_publication_tables check)");
  }

  // ---- History up to today --------------------------------------------
  await db.exec(read("schema.sql"));

  // Pre-auth era tasks, shaped like the real board: parents with sub-tasks,
  // across areas, plus one unrecognised area to exercise the fallback.
  await db.exec(`
    insert into public.tasks (id, title, area, status) values
      ('p_yt',  'Beccles Broads',        'youtube',    'backlog'),
      ('p_con', 'Prove it works',        'consulting', 'backlog'),
      ('p_sk',  'Level up credentials',  'skill',      'todo'),
      ('p_hob', 'Pi sensor project',     'hobby',      'progress'),
      ('p_inv', 'Open brokerage',        'invest',     'blocked'),
      ('p_oth', 'Renew passport',        'other',      'backlog'),
      ('p_odd', 'Legacy oddity',         'misc',       'backlog');
    insert into public.tasks (id, title, area, status, parent_id) values
      ('c_yt1', 'Video shoot',   'youtube',    'backlog', 'p_yt'),
      ('c_yt2', 'Video edit',    'youtube',    'backlog', 'p_yt'),
      ('c_con', 'Pricing review','consulting', 'backlog', 'p_con'),
      ('c_sk',  'Prompt course', 'skill',      'progress','p_sk');
  `);

  await db.exec(read("migrations/001_boards_additive.sql"));
  await db.exec(`insert into auth.users (id, email) values ('${SIYAD}', 'siyad@test.local');`);
  await db.exec(read("migrations/002_boards_cutover.sql").replace("you@example.com", "siyad@test.local"));
  await db.exec(read("migrations/003_board_invites.sql"));
  await db.exec(read("migrations/004_member_area_visibility.sql"));

  // 004-era sharing state that 005 must retire cleanly.
  await db.exec(`insert into auth.users (id, email) values ('${WIFE}', 'wife@test.local');`);
  const siyadBoard = (await one(`select board_id from board_members where user_id = $1`, [SIYAD])).board_id;
  const wifeBoard = (await one(`select board_id from board_members where user_id = $1`, [WIFE])).board_id;
  const household = (await one(`insert into boards (name, created_by) values ('Household', $1) returning id`, [SIYAD])).id;
  await db.exec(`
    insert into board_members (board_id, user_id, role) values ('${household}', '${SIYAD}', 'owner');
    insert into board_members (board_id, user_id, role, visible_areas) values ('${household}', '${WIFE}', 'member', array['other']);
    insert into board_invites (board_id, email, role, visible_areas) values ('${household}', 'later@test.local', 'member', array['hobby']);
    insert into tasks (id, title, area, status, board_id) values ('h_bill', 'Pay council tax', 'other', 'todo', '${household}');
  `);

  const before = await q(`select id, area, board_id from tasks order by id`);
  const legacyName = { youtube: "YouTube", consulting: "Consulting", skill: "Skill Dev", hobby: "Hobby / Pi", invest: "Investing", other: "Other" };

  // ---- 005 ----------------------------------------------------------
  console.log("\nApplying 005…");
  await db.exec(read("migrations/005_per_board_areas.sql"));

  console.log("\nData mapping");
  const after = await q(`select t.id, t.board_id, a.name area_name, a.board_id area_board
                         from tasks t join board_areas a on a.id = t.area_id order by t.id`);
  check("every task kept", after.length === before.length, `${before.length} -> ${after.length}`);
  const wrong = before.filter((b) => {
    const a = after.find((x) => x.id === b.id);
    return !a || a.area_name !== (legacyName[b.area] || "Other") || a.area_board !== a.board_id;
  });
  check("each task on its own board's copy of its old area", wrong.length === 0, wrong.map((w) => w.id).join(","));
  check("unrecognised area fell back to Other", after.find((x) => x.id === "p_odd").area_name === "Other");
  const areaCol = await one(`select count(*)::int n from information_schema.columns where table_name='tasks' and column_name='area'`);
  check("old tasks.area column dropped", areaCol.n === 0);
  const myAreas = await q(`select name, color from board_areas where board_id = $1 order by position`, [siyadBoard]);
  check("My Board has the six areas, in order and colour",
    JSON.stringify(myAreas.map((a) => a.name + ":" + a.color)) ===
      JSON.stringify(["YouTube:madder", "Consulting:indigo", "Skill Dev:murex", "Hobby / Pi:verdigris", "Investing:brass", "Other:slate"]));
  const visCols = await one(`select count(*)::int n from information_schema.columns where column_name='visible_areas'`);
  check("area-limit columns removed", visCols.n === 0);

  console.log("\nSignups and invites");
  await db.exec(`insert into auth.users (id, email) values ('${LATER}', 'later@test.local');`);
  const laterBoards = await q(`select b.name, m.role from board_members m join boards b on b.id = m.board_id where m.user_id = $1 order by b.name`, [LATER]);
  check("new signup still works and claims invite", JSON.stringify(laterBoards) === JSON.stringify([{ name: "Household", role: "member" }, { name: "My Board", role: "owner" }]), JSON.stringify(laterBoards));
  const laterOwn = laterBoards.length && (await one(`select b.id from boards b join board_members m on m.board_id=b.id where m.user_id=$1 and b.name='My Board'`, [LATER])).id;
  const laterAreas = await q(`select name from board_areas where board_id = $1`, [laterOwn]);
  check("new board starts with one 'General' area", laterAreas.length === 1 && laterAreas[0].name === "General");
  await db.exec(`insert into board_invites (board_id, email, role) values ('${siyadBoard}', 'wife@test.local', 'member')`);
  const claimed = await as(WIFE, () => one(`select public.claim_board_invites() n`));
  check("existing account can claim an invite", claimed.n === 1);
  await db.exec(`delete from board_members where board_id='${siyadBoard}' and user_id='${WIFE}'`);

  console.log("\nVisibility (area limits retired, boards still private)");
  const wifeSeesHousehold = await as(WIFE, () => q(`select id from tasks where board_id = $1`, [household]));
  check("member sees whole shared board", wifeSeesHousehold.length === 1);
  const wifeSeesMine = await as(WIFE, () => q(`select id from tasks where board_id = $1`, [siyadBoard]));
  check("member can't see owner's private board", wifeSeesMine.length === 0);
  const wifeAreasMine = await as(WIFE, () => q(`select id from board_areas where board_id = $1`, [siyadBoard]));
  check("…or its areas", wifeAreasMine.length === 0);

  console.log("\nMoving tasks between boards");
  const hhOther = (await one(`select id from board_areas where board_id=$1 and name='Other'`, [household])).id;
  await as(SIYAD, () => q(`update tasks set board_id = $1, area_id = $2 where id = 'p_yt'`, [household, hhOther]));
  const fam = await q(`select id, board_id, area_id from tasks where id in ('p_yt','c_yt1','c_yt2') order by id`);
  check("parent and sub-tasks moved together", fam.every((t) => t.board_id === household && t.area_id === hhOther), JSON.stringify(fam.map((t) => t.id)));
  const wifeSeesMoved = await as(WIFE, () => q(`select id from tasks where id in ('p_yt','c_yt1','c_yt2')`));
  check("moved family now visible to shared-board member", wifeSeesMoved.length === 3);

  const wifeGeneral = (await one(`select id from board_areas where board_id=$1`, [wifeBoard])).id;
  check("can't move into a board you're not on",
    !!(await fails(() => as(SIYAD, () => q(`update tasks set board_id=$1, area_id=$2 where id='p_con'`, [wifeBoard, wifeGeneral])))));
  const myOther = (await one(`select id from board_areas where board_id=$1 and name='Other'`, [siyadBoard])).id;
  const errOut = await fails(() => as(WIFE, () => q(`update tasks set board_id=$1, area_id=$2 where id='h_bill'`, [siyadBoard, myOther])));
  const billStill = await one(`select board_id from tasks where id='h_bill'`);
  check("member can't move a shared task into owner's private board", !!errOut || billStill.board_id === household);
  check("area from another board is rejected",
    !!(await fails(() => as(SIYAD, () => q(`update tasks set area_id=$1 where id='p_con'`, [hhOther])))));

  const myYt = (await one(`select id from board_areas where board_id=$1 and name='YouTube'`, [siyadBoard])).id;
  await as(SIYAD, () => q(`insert into tasks (id, title, status, parent_id, board_id, area_id) values ('c_new','x','backlog','p_con',$1,$2)`, [siyadBoard, myYt]));
  const cnew = await one(`select a.name from tasks t join board_areas a on a.id=t.area_id where t.id='c_new'`);
  check("sub-task always takes its parent's area", cnew.name === "Consulting", cnew.name);
  check("can't add a sub-task under a task on someone else's board",
    !!(await fails(() => as(WIFE, () => q(`insert into tasks (id,title,status,parent_id,board_id,area_id) values ('c_bad','x','backlog','p_con',$1,$2)`, [wifeBoard, wifeGeneral])))));

  console.log("\nManaging areas");
  check("member can't add areas to a shared board",
    !!(await fails(() => as(WIFE, () => q(`insert into board_areas (board_id,name,color) values ($1,'Kids','olive')`, [household])))));
  await as(SIYAD, () => q(`insert into board_areas (board_id,name,color,position) values ($1,'Home','sepia',6)`, [household]));
  check("owner can add an area", !!(await one(`select 1 from board_areas where board_id=$1 and name='Home'`, [household])));
  check("duplicate name (any case) rejected",
    !!(await fails(() => as(SIYAD, () => q(`insert into board_areas (board_id,name,color) values ($1,'home','sepia')`, [household])))));
  check("colour outside the palette rejected",
    !!(await fails(() => as(SIYAD, () => q(`insert into board_areas (board_id,name,color) values ($1,'Pink','#ff00ff')`, [household])))));

  const hhHome = (await one(`select id from board_areas where board_id=$1 and name='Home'`, [household])).id;
  check("member can't delete areas",
    !!(await fails(() => as(WIFE, () => q(`select public.delete_board_area($1,$2)`, [hhOther, hhHome])))));
  const noTarget = await fails(() => as(SIYAD, () => q(`select public.delete_board_area($1)`, [hhOther])));
  check("deleting an area with tasks needs a target", !!noTarget && noTarget.includes("choose an area"), noTarget || "");
  check("target on another board rejected",
    !!(await fails(() => as(SIYAD, () => q(`select public.delete_board_area($1,$2)`, [hhOther, myOther])))));
  const moved = await as(SIYAD, () => one(`select public.delete_board_area($1,$2) n`, [hhOther, hhHome]));
  const inHome = await q(`select id from tasks where area_id=$1 order by id`, [hhHome]);
  check("delete moves tasks, sub-tasks included, then removes area",
    moved.n === 4 && inHome.length === 4 && !(await one(`select 1 x from board_areas where id=$1`, [hhOther])), `moved ${moved.n}`);

  const lastErr = await fails(() => as(SIYAD, () => q(`delete from board_areas where board_id=$1`, [household])));
  check("a board keeps at least one area", !!lastErr, lastErr || "");
  await db.exec(`delete from boards where id='${laterOwn}'`);
  check("deleting a whole board still works", !(await one(`select 1 x from board_areas where board_id=$1`, [laterOwn])));

  console.log("\nRe-run safety");
  const countBefore = await one(`select count(*)::int n from board_areas`);
  await db.exec(read("migrations/005_per_board_areas.sql"));
  const countAfter = await one(`select count(*)::int n from board_areas`);
  check("running 005 twice changes nothing", countBefore.n === countAfter.n);

  // ---- 006 ----------------------------------------------------------
  console.log("\nApplying 006…");
  const res006 = await db.exec(read("migrations/006_board_sharing.sql"));
  const check006 = res006[res006.length - 1].rows[0];
  check("006's own check reports zeros", Number(check006.boards_without_an_owner) === 0 && Number(check006.old_create_policy_left) === 0, JSON.stringify(check006));

  const EXIST = "44444444-4444-4444-4444-444444444444";
  const NEWBIE = "55555555-5555-5555-5555-555555555555";
  const SOLO = "66666666-6666-6666-6666-666666666666";
  await db.exec(`insert into auth.users (id, email) values ('${EXIST}', 'exists@test.local');`);
  const boardsOf = (uid) => q(`select b.name, m.role from board_members m join boards b on b.id=m.board_id where m.user_id=$1 order by b.name`, [uid]);

  console.log("\nCreating boards");
  const garden = (await as(WIFE, () => one(`select public.create_board('  Garden ') id`))).id;
  const gardenRow = await one(`select name from boards where id=$1`, [garden]);
  check("create_board makes the caller its owner, name trimmed",
    gardenRow.name === "Garden" && (await one(`select role from board_members where board_id=$1 and user_id=$2`, [garden, WIFE]))?.role === "owner");
  const gardenAreas = await q(`select name from board_areas where board_id=$1`, [garden]);
  check("…with a General area", gardenAreas.length === 1 && gardenAreas[0].name === "General");
  check("…visible to its owner through RLS", (await as(WIFE, () => q(`select id from boards where id=$1`, [garden]))).length === 1);
  check("…and nobody else", (await as(SIYAD, () => q(`select id from boards where id=$1`, [garden]))).length === 0);
  check("blank board name refused", !!(await fails(() => as(WIFE, () => q(`select public.create_board('   ')`)))));
  check("long board name refused", !!(await fails(() => as(WIFE, () => q(`select public.create_board($1)`, ["x".repeat(61)])))));
  const anonErr = await fails(async () => {
    await db.exec(`set role anon;`);
    try { await q(`select public.create_board('Sneaky')`); } finally { await db.exec(`reset role;`); }
  });
  check("signed-out caller can't create boards", !!anonErr, anonErr || "");
  check("direct insert into boards no longer allowed (would make an unopenable board)",
    !!(await fails(() => as(SIYAD, () => q(`insert into boards (name, created_by) values ('Orphan', $1)`, [SIYAD])))));

  console.log("\nInviting");
  check("member can't invite", !!(await fails(() => as(WIFE, () => q(`select public.invite_to_board($1,'x@test.local')`, [household])))));
  check("owner of another board can't invite to this one", !!(await fails(() => as(WIFE, () => q(`select public.invite_to_board($1,'x@test.local')`, [siyadBoard])))));
  await as(SIYAD, () => q(`select public.invite_to_board($1,' Nobody@Test.local ')`, [household]));
  await as(SIYAD, () => q(`select public.invite_to_board($1,'exists@test.local')`, [household]));
  const pend = await q(`select email from board_invites where board_id=$1 order by email`, [household]);
  check("invites stored trimmed and lower-case", JSON.stringify(pend.map((p) => p.email)) === JSON.stringify(["exists@test.local", "nobody@test.local"]), JSON.stringify(pend));
  check("inviting an existing account does NOT add them yet (no account-existence leak)",
    !(await one(`select 1 x from board_members where board_id=$1 and user_id=$2`, [household, EXIST])));
  await as(SIYAD, () => q(`select public.invite_to_board($1,'NOBODY@test.local')`, [household]));
  check("inviting again is a quiet no-op", (await q(`select 1 from board_invites where board_id=$1`, [household])).length === 2);
  const selfErr = await fails(() => as(SIYAD, () => q(`select public.invite_to_board($1,'SIYAD@test.local')`, [household])));
  check("own email refused", !!selfErr && selfErr.includes("your own"), selfErr || "");
  const dupErr = await fails(() => as(SIYAD, () => q(`select public.invite_to_board($1,'wife@test.local')`, [household])));
  check("someone already on the board refused", !!dupErr && dupErr.includes("already on this board"), dupErr || "");
  check("malformed email refused", !!(await fails(() => as(SIYAD, () => q(`select public.invite_to_board($1,'not an email')`, [household])))));

  console.log("\nListing members");
  const ownerView = await as(SIYAD, () => q(`select kind, email, role, is_you from public.list_board_members($1)`, [household]));
  check("owner sees members (owner first, marked as you) and pending invites",
    JSON.stringify(ownerView) === JSON.stringify([
      { kind: "member", email: "siyad@test.local", role: "owner", is_you: true },
      { kind: "member", email: "later@test.local", role: "member", is_you: false },
      { kind: "member", email: "wife@test.local", role: "member", is_you: false },
      { kind: "invite", email: "exists@test.local", role: "member", is_you: false },
      { kind: "invite", email: "nobody@test.local", role: "member", is_you: false },
    ]), JSON.stringify(ownerView));
  const memberView = await as(WIFE, () => q(`select kind, email from public.list_board_members($1)`, [household]));
  check("member sees members but not invites", memberView.length === 3 && memberView.every((r) => r.kind === "member"), JSON.stringify(memberView));
  check("outsider sees nothing", (await as(EXIST, () => q(`select * from public.list_board_members($1)`, [household]))).length === 0);
  check("outsider can't read invites directly either", (await as(EXIST, () => q(`select * from board_invites`))).length === 0);

  console.log("\nAccepting");
  await db.exec(`insert into board_invites (board_id, email, role) values ('${household}', 'newbie@test.local', 'member')`);
  await db.exec(`insert into auth.users (id, email) values ('${NEWBIE}', 'newbie@test.local');`);
  check("new signup gets their own board but doesn't join invited boards yet",
    JSON.stringify(await boardsOf(NEWBIE)) === JSON.stringify([{ name: "My Board", role: "owner" }]), JSON.stringify(await boardsOf(NEWBIE)));
  await as(NEWBIE, () => q(`select public.claim_board_invites()`));
  await as(EXIST, () => q(`select public.claim_board_invites()`));
  check("signing in to the app claims the invite (new account)",
    JSON.stringify(await boardsOf(NEWBIE)) === JSON.stringify([{ name: "Household", role: "member" }, { name: "My Board", role: "owner" }]));
  check("…and for an existing account",
    !!(await one(`select 1 x from board_members where board_id=$1 and user_id=$2`, [household, EXIST])));
  check("claimed invites are removed", !(await one(`select 1 x from board_invites where board_id=$1 and email in ('newbie@test.local','exists@test.local')`, [household])));

  console.log("\nRemoving, leaving, cancelling");
  await as(WIFE, () => q(`delete from board_members where board_id=$1 and user_id=$2`, [household, LATER]));
  check("member can't remove someone else", !!(await one(`select 1 x from board_members where board_id=$1 and user_id=$2`, [household, LATER])));
  await as(SIYAD, () => q(`delete from board_members where board_id=$1 and user_id=$2`, [household, LATER]));
  check("owner can remove a member", !(await one(`select 1 x from board_members where board_id=$1 and user_id=$2`, [household, LATER])));
  check("removed member loses the board's tasks", (await as(LATER, () => q(`select id from tasks where board_id=$1`, [household]))).length === 0);
  await as(NEWBIE, () => q(`delete from board_members where board_id=$1 and user_id=$2`, [household, NEWBIE]));
  check("member can leave", !(await one(`select 1 x from board_members where board_id=$1 and user_id=$2`, [household, NEWBIE])));
  const leaveErr = await fails(() => as(SIYAD, () => q(`delete from board_members where board_id=$1 and user_id=$2`, [household, SIYAD])));
  check("last owner can't leave", !!leaveErr && leaveErr.includes("needs an owner"), leaveErr || "");
  await as(WIFE, () => q(`delete from board_invites where board_id=$1`, [household]));
  check("member can't cancel invites", !!(await one(`select 1 x from board_invites where board_id=$1`, [household])));
  await as(SIYAD, () => q(`delete from board_invites where board_id=$1 and email=$2`, [household, "nobody@test.local"]));
  check("owner can cancel an invite", !(await one(`select 1 x from board_invites where board_id=$1`, [household])));

  console.log("\nDeleting boards");
  const gGen = (await one(`select id from board_areas where board_id=$1`, [garden])).id;
  await as(WIFE, () => q(`insert into tasks (id,title,status,board_id,area_id) values ('g_p','Plant bulbs','todo',$1,$2)`, [garden, gGen]));
  await as(WIFE, () => q(`insert into tasks (id,title,status,board_id,area_id,parent_id) values ('g_c','Buy bulbs','todo',$1,$2,'g_p')`, [garden, gGen]));
  await as(WIFE, () => q(`select public.invite_to_board($1,'exists@test.local')`, [garden]));
  check("non-owner can't delete a board", !!(await fails(() => as(SIYAD, () => q(`select public.delete_board($1,'Garden')`, [garden])))));
  check("member can't delete a shared board", !!(await fails(() => as(WIFE, () => q(`select public.delete_board($1,'Household')`, [household])))));
  const nameErr = await fails(() => as(WIFE, () => q(`select public.delete_board($1,'garden')`, [garden])));
  check("wrong name refused (case matters)", !!nameErr && nameErr.includes("doesn't match"), nameErr || "");
  check("…and the board is untouched", !!(await one(`select 1 x from boards where id=$1`, [garden])));
  await as(WIFE, () => q(`select public.delete_board($1,' Garden ')`, [garden]));
  const gone = await one(`select
      (select count(*) from boards where id=$1)::int b, (select count(*) from board_areas where board_id=$1)::int a,
      (select count(*) from tasks where board_id=$1)::int t, (select count(*) from board_members where board_id=$1)::int m,
      (select count(*) from board_invites where board_id=$1)::int i`, [garden]);
  check("owner deletes board with its tasks, areas, members and invites", gone.b + gone.a + gone.t + gone.m + gone.i === 0, JSON.stringify(gone));
  check("owner's other boards untouched", JSON.stringify(await boardsOf(WIFE)) === JSON.stringify([{ name: "Household", role: "member" }, { name: "My Board", role: "owner" }]));

  await db.exec(`insert into auth.users (id, email) values ('${SOLO}', 'solo@test.local');`);
  const soloBoard = (await one(`select board_id from board_members where user_id=$1`, [SOLO])).board_id;
  const onlyErr = await fails(() => as(SOLO, () => q(`select public.delete_board($1,'My Board')`, [soloBoard])));
  check("can't delete your only board", !!onlyErr && onlyErr.includes("only board"), onlyErr || "");
  await db.exec(`delete from auth.users where id='${SOLO}'`);
  check("deleting an account isn't blocked by the owner guard", !(await one(`select 1 x from board_members where user_id=$1`, [SOLO])));

  const hhTasks = (await one(`select count(*)::int n from tasks where board_id=$1`, [household])).n;
  const myTasksBefore = (await one(`select count(*)::int n from tasks where board_id=$1`, [siyadBoard])).n;
  await as(SIYAD, () => q(`select public.delete_board($1,'Household')`, [household]));
  check("deleting a shared board removes it for its members too", !(await one(`select 1 x from board_members where board_id=$1`, [household])) && hhTasks > 0, `${hhTasks} tasks went`);
  check("owner's private board untouched", (await one(`select count(*)::int n from tasks where board_id=$1`, [siyadBoard])).n === myTasksBefore);

  console.log("\nRe-run safety (006)");
  await db.exec(read("migrations/006_board_sharing.sql"));
  check("running 006 twice is fine", (await q(`select id from boards`)).length > 0);

  console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  process.exit(2);
});
