# Migration tests

Replays the full migration history — `schema.sql`, then `migrations/001…` in
order — on PGlite, a real Postgres that runs inside Node. No database server
or Docker needed. Supabase's `auth` schema and roles are stubbed just enough
for the policies to behave as they do in production.

```bash
cd supabase/tests
npm install
npm test
```

Uses made-up test accounts only. Add checks here before running a new
migration against the live project.
