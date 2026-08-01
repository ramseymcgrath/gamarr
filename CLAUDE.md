# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gamarr is a LAN-hosted game catalog and **manual** Usenet download manager: it searches IGDB by platform, searches Newznab-compatible indexers for a selected game, explains its match evidence, and sends a chosen NZB to SABnzbd. It deliberately does not monitor wanted games, choose downloads automatically, or run a background scheduler when idle. It has no user login — the trust boundary is the LAN plus an operator-configured origin allowlist.

Design spec: `docs/superpowers/specs/2026-07-31-gamarr-v1-design.md` (authoritative for the download lifecycle, data model, and security requirements).

## Commands

Requires Node 24 and pnpm (`corepack enable`).

```bash
GAMARR_DATABASE_PATH=./data/gamarr.db pnpm db:migrate     # apply migrations before first dev run
GAMARR_DATABASE_PATH=./data/gamarr.db \
GAMARR_ALLOWED_ORIGINS=http://localhost:3000 pnpm dev

pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run (unit + component; excludes tests/e2e)
pnpm build
```

`GAMARR_ALLOWED_ORIGINS` is required at runtime — mutating routes throw if it is empty.

Single test / focused runs:

```bash
pnpm test src/features/downloads/service.test.ts
pnpm test -t "rejects a cross-origin mutation"
pnpm test:watch
```

End-to-end (Playwright spawns both the stub provider server on :4100 and a dev server on :3200, and `global-setup.ts` recreates `test-results/e2e/gamarr.db` from `drizzle/`):

```bash
pnpm test:e2e
pnpm exec playwright test tests/e2e/setup-and-download.spec.ts
```

Database schema changes:

```bash
pnpm db:generate   # drizzle-kit generate -> new drizzle/NNNN_*.sql
pnpm db:migrate    # node scripts/migrate.mjs (also the container entrypoint)
```

## Architecture

### Request path

Every API route follows the same four-file split. Keep it — it is what makes handlers testable without Next.js.

```
src/app/api/<area>/route.ts          thin shim: runtime/dynamic exports, calls the handler
src/app/api/<area>/dependencies.ts   composition root: `import "server-only"`, builds
                                     repositories/clients/services from env + getDatabase()
src/app/api/<area>/handlers.ts       real logic: auth guard, input validation, service call,
                                     errorResponse() — takes dependencies as a parameter
src/app/api/<area>/handlers.test.ts  tests the handler with hand-rolled fakes
```

Handlers declare a narrow structural interface for the service they need (e.g. `ReleaseSearchHandlerService`) rather than importing the concrete class, so tests inject plain objects. Routes set `runtime = "nodejs"` and `dynamic = "force-dynamic"` (better-sqlite3 is native; nothing here may run on edge).

### Feature slices

`src/features/<name>/` uses a consistent quintet: `models.ts` (domain types), `ports.ts` (interfaces for anything external), `repository.ts` (the only place Drizzle is used, named `Sqlite*Repository`), `service.ts` (orchestration, depends only on ports), plus colocated `*.test.ts`. React screens for a feature live in the same directory (`discover-screen.tsx`, `settings-screen.tsx`, …).

`src/integrations/<vendor>/` holds the concrete adapters (igdb, newznab, sabnzbd) that satisfy those ports. Services receive them via constructor injection — often as a factory (`clientFactory: (indexer) => new NewznabClient(...)`) since indexers are configured at runtime.

The boundary to preserve: features reach the outside world only through their ports, and `dependencies.ts` is what binds a port to a concrete adapter. Features do not import integration *clients*. (The one deliberate exception is `release-search/service.ts` importing `newznab/url-policy` — a pure validation module with no I/O.)

### Database

`getDatabase()` in `src/db/client.ts` is a lazy singleton reading `GAMARR_DATABASE_PATH`. It enforces `foreign_keys=ON`, WAL, a 250ms busy timeout, and chmods the directory to `0700` / file to `0600`. `scripts/migrate.mjs` intentionally duplicates that pragma/permission setup because it runs standalone from the container entrypoint, before the app boots, against a trimmed `node_modules`.

better-sqlite3 is **synchronous**: transactions must stay short and must never contain an external `await`. Claim the row first, then do network I/O outside the transaction (see `DownloadService.submit`).

## Invariants worth knowing before editing

**Migrations in `drizzle/` are immutable once committed.** Editing an applied file diverges deployed databases from dev — Drizzle's journal will not re-run it. Always generate a new one. `0002_repair_postprocessing_failures.sql` is a data-repair migration, not just DDL.

**Secrets must never reach the client.** Indexer API keys are embedded in Newznab download URLs and IGDB client secrets live in SQLite. `DownloadUrlPolicyError` deliberately omits the offending URL from the error because those messages surface in user-facing warnings. The settings API returns `Public*Settings` shapes that replace each secret with a `hasClientSecret` / `hasApiKey` boolean — the `*Record` types holding the real values must never be serialized to a response. Do not put URLs or secrets in React Query keys or error reports.

**Mutating routes go through `assertTrustedMutation(request, policy)`** (`src/lib/trusted-mutation.ts`), which enforces the exact scheme/host/port allowlist from `GAMARR_ALLOWED_ORIGINS`, optionally accepts `GAMARR_API_TOKEN` as a bearer for automation, and only honors forwarded headers when `GAMARR_TRUST_PROXY=true`. GET routes for Library and Activity are read-only; refresh, reconcile, connection tests, platform sync, and delete are all guarded non-GET.

**Errors:** throw `AppError` (or the `validationError` / `forbiddenError` helpers) from `src/lib/errors.ts` and let `errorResponse()` in `src/app/api/error-response.ts` serialize it. Anything that is not an `AppError` becomes a generic 500 — never let a raw upstream error message through, since it may carry a key.

**Download submission is idempotent.** The client supplies a `submissionKey`; the service computes a `requestFingerprint` and, on replay, either returns the existing attempt or fails if the same key arrives with different content. The `Unknown` status means an ambiguous outcome (e.g. a lost SABnzbd acknowledgement) — it is reconciled against a durable `sabMarker`, never resubmitted automatically. Status writes use monotonic compare-and-set so a stale response cannot overwrite a terminal state.

**Indexer failures are per-indexer.** One failing indexer produces a warning alongside the other indexers' successful results; it must not fail the whole search. Newznab download URLs are validated by `url-policy.ts` (same-origin as the indexer, no credentials or fragments, http/https only) and NZBs are size-bounded via `read-bounded-response.ts` and never written to disk.

**Accessibility is a requirement, not a nicety** (WCAG 2.2 AA, asserted in e2e via `@axe-core/playwright`). Status and match rank must always encode meaning in text *and* icon/shape, not color alone.

## Testing conventions

- Unit and component tests are colocated next to the source file as `*.test.ts` / `*.test.tsx`.
- The vitest environment is `node` by default. Component tests must opt in with a first-line `/** @vitest-environment jsdom */` docblock.
- `server-only` is aliased to a no-op stub (`tests/server-only.ts`) so `dependencies.ts`-style modules can be imported under vitest.
- Path aliases: `@/*` → `src/*`, `@tests/*` → `tests/*`.
- `clearMocks` and `restoreMocks` are on globally; don't hand-roll teardown for spies.
- Prefer hand-written fakes implementing a port over mocking modules; MSW is available for HTTP-level stubbing.
- E2E drives real upstreams via the stub server in `tests/provider-server/`, pointed at by `GAMARR_TWITCH_TOKEN_URL` / `GAMARR_IGDB_BASE_URL`. It runs single-worker and non-parallel because it shares one SQLite file.

## Container

Multi-stage build; the runner stage copies the Next.js standalone output plus a trimmed `node_modules` containing only better-sqlite3 and drizzle-orm for the migrator. `entrypoint.sh` runs `migrate.mjs` before `node server.js`. The image runs as uid 1001 with a read-only root filesystem, all capabilities dropped, and `/config` as the only writable volume — anything new that needs to write must go under `/config` or the `/tmp` tmpfs. CI publishes `linux/amd64` only; arm64 under QEMU times out because better-sqlite3 compiles from source.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8989` | HTTP listen port |
| `GAMARR_DATABASE_PATH` | `/config/gamarr.db` | SQLite database |
| `GAMARR_MIGRATIONS_PATH` | `./drizzle` | Migration folder (set to `/app/drizzle` in the image) |
| `GAMARR_ALLOWED_ORIGINS` | none — required | Comma-separated exact browser origins allowed to mutate state |
| `GAMARR_API_TOKEN` | none | Optional bearer token for trusted automation |
| `GAMARR_TRUST_PROXY` | `false` | Honor forwarded host/protocol; only safe behind a trusted reverse proxy |
