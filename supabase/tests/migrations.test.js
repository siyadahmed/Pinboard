// Replays Pinboard's migration history on a real Postgres (PGlite), then
// applies 005 and checks data mapping, access rules and area/board rules.
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

  console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  process.exit(2);
});
