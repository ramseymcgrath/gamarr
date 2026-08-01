---
name: db-migration
description: Generate, review, and apply a Drizzle schema migration for Gamarr
disable-model-invocation: true
---

# Adding a database migration

Gamarr uses Drizzle with better-sqlite3. Migrations are plain SQL files in
`drizzle/`, numbered and tracked in `drizzle/meta/_journal.json`.

## Procedure

**1. Edit the schema.** All tables live in `src/db/schema.ts`. Change it there —
never hand-write a migration file.

**2. Generate.**

```bash
pnpm db:generate
```

This diffs `src/db/schema.ts` against the journal snapshot and emits the next
`drizzle/NNNN_<name>.sql`, updating `drizzle/meta/`.

**3. Read the generated SQL before doing anything else.** Drizzle's SQLite
support cannot alter columns in place; it emits a table rebuild
(`CREATE TABLE __new_x` → copy → `DROP` → `RENAME`). Verify that:

- Every column you meant to keep appears in the `INSERT INTO ... SELECT`.
  Anything omitted is silently dropped along with its data.
- `NOT NULL` columns added to a populated table have a `DEFAULT`, otherwise the
  rebuild fails at runtime on any non-empty database.
- Foreign keys still point where you expect. `foreign_keys` is `ON`, so a
  rebuild that reorders operations can trip a constraint.

**4. Add a data-repair step if existing rows need fixing.** Migrations are the
only place this happens — see `0002_repair_postprocessing_failures.sql` for the
established shape. Write the repair as idempotent SQL: it may run against
databases in several different states.

**5. Apply locally.**

```bash
GAMARR_DATABASE_PATH=./data/gamarr.db pnpm db:migrate
```

**6. Verify.**

```bash
pnpm test
pnpm test:e2e   # global-setup.ts rebuilds its fixture DB from drizzle/ every run
```

The e2e suite is the real check that the migration applies cleanly from zero.

## Rules

**Never edit a migration that already exists.** Drizzle records it in the journal
and will not re-run it, so every database that already applied it — your dev DB,
the e2e fixture, the deployed `/config` volume — stays on the old shape while the
file claims otherwise. Fix a bad migration by generating a new one that corrects
it. A PreToolUse hook enforces this.

**Never hand-edit `drizzle/meta/_journal.json`.** It is generated, and desyncing
it from the SQL files makes the migration state unrecoverable without manual
surgery on every deployment.

**Keep transactions short and free of `await`.** better-sqlite3 is synchronous;
an `await` inside a transaction holds the write lock across the event loop and
will hit the 250ms `busy_timeout` under concurrency.

## Deployment note

`scripts/migrate.mjs` runs from the container entrypoint before the app starts,
against a trimmed `node_modules` containing only better-sqlite3 and drizzle-orm.
It reads `GAMARR_MIGRATIONS_PATH` (`/app/drizzle` in the image). If a migration
needs anything beyond those two packages, it will fail in the container while
passing locally.
