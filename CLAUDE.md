# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gamarr is a LAN-hosted game catalog and **manual** download manager: it searches IGDB by platform, discovers and searches every enabled indexer in Prowlarr plus Internet Archive directly, explains its match evidence, and routes a chosen release by protocol — usenet to SABnzbd and torrents to qBittorrent. It deliberately does not monitor wanted games, choose downloads automatically, or run a background scheduler when idle. It has no user login — the trust boundary is the LAN plus an operator-configured origin allowlist.

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

`src/integrations/<vendor>/` holds the concrete adapters (igdb, prowlarr, sabnzbd, qbittorrent) that satisfy those ports. Services receive them through constructor injection. Prowlarr is the indexer connection; its adapter discovers enabled indexers at request time and searches each one individually. `internet-archive` is the one source searched directly (see below).

The boundary to preserve: features reach the outside world only through their ports, and `dependencies.ts` is what binds a port to a concrete adapter. Features do not import integration *clients*. The deliberate exceptions are pure validation/decoding modules with no I/O: `prowlarr/url-policy` and `prowlarr/metainfo` in the release-search service, and `prowlarr/metainfo` in the downloads service.

Search fans out over every enabled Prowlarr indexer with per-indexer failure isolation, and in parallel makes one Internet Archive `advancedsearch` request, and each release carries a `usenet` or `torrent` protocol. Usenet payloads go to SABnzbd; torrent payloads or validated magnets go to qBittorrent.

**Internet Archive is searched directly, not through Prowlarr.** archive.org stalls any request whose User-Agent contains `Prowlarr` (observed Nov 2026: no response for 100s+, while other agents get sub-second replies), so its Prowlarr indexer was removed. `src/integrations/internet-archive/client.ts` follows https://archive.org/developers/bots.html: every request (including redirect hops to `*.archive.org` data nodes) sends `User-Agent: gamarr/<package.json version>`; `429`/`502`/`503`/`504` and network errors retry with exponential backoff; `Retry-After` is honored up to 10s and a longer one fails the search with a warning instead of sleeping; repeat searches are served from a 10-minute in-process cache. Results become `torrent` releases from the pseudo-indexer `internet-archive` (priority 0) pointing at the item's canonical `archive.org/download/<id>/<id>_archive.torrent` — never a data-node URL — and are ranked with `PREFERRED_SOURCE_BONUS` (title-matched archive items outrank any indexer release; platform conflicts still sink them). Candidates persist only the validated identifier; `routeReleaseFetch` sends them to `InternetArchiveTorrentFetcher` and everything else to `ProwlarrFetcher`. Grabs are recorded as `internet-archive-torrent`. `GET /api/releases/files` decodes bounded torrent metainfo for optional file selection, which is applied after qBittorrent reports metadata. Gamarr does not write release payloads to disk, and torrent attempts survive a restart for later reconciliation.

**Completed downloads are verified against Redump.** When reconcile moves an attempt to `Completed`, `DownloadService` calls `onCompleted`, which queues a row in `download_verifications`; `VerificationService` drains that queue one attempt at a time in the background (never on a request path — hashing a DVD image is gigabytes of I/O) and `instrumentation.ts` resets interrupted `Running` rows at startup. The verifier asks the download client where the files are (qBittorrent `content_path`, SABnzbd history `storage`), maps that container path onto gamarr's read-only `/library` mount with `GAMARR_DOWNLOAD_PATH_MAP` (longest prefix wins; anything escaping the mapped root is refused; symlinks are never followed), then for each `.iso`/`.bin`/`.img`: skips hashing when no Redump rom has that exact size, otherwise SHA-1s it, and reads the disc serial from `SYSTEM.CNF` (ISO 9660, 2048- or raw 2352-byte sectors). Verdicts: `Verified` (every image's hash is in Redump), `Mismatch` (a known serial with the wrong hash, or a disc for another system), `Unknown` (not in Redump, nothing contradicts it), `Unsupported` (compressed, unmapped, or a platform without a list), `Failed` (the check itself failed). Checksum lists come from libretro-database's mirror of the Redump DATs (redump.org refuses connections from this network), cached in `<database dir>/redump/` for 7 days with stale-cache fallback. Supported platforms are `REDUMP_SYSTEMS` (IGDB 8 = PS2, 7 = PS1). `POST /api/downloads/:id/verify` re-runs a check.

**Archives are checked without extracting.** When a download has no plain image but has `.7z`/`.zip`/`.rar` (only the first volume of a `.partN.rar` set), `SevenZipArchives` lists it and streams each `.iso`/`.bin`/`.img` entry out of 7-Zip's stdout: one pass hashes it and keeps the first 16 MiB for `SYSTEM.CNF`; when the size already rules out a Redump match only the head is read. 7-Zip runs via `spawn` with an argv array, `-spd` (literal names), a dummy `-p` (encrypted archives fail instead of prompting) and `--`; a non-zero exit after the last chunk (the archive's own CRC failed) fails the check. The runtime image installs Debian `7zip` + non-free `7zip-rar` for RAR/RAR5.

**Verified PS2 games are copied into the Open PS2 Loader share** (`GAMARR_PS2_LIBRARY_DIR`). The user plays on a real PS2 through OPL, which only reads plain 2048-byte-sector `.iso` files in `DVD/` and `CD/` — never CHD/CSO. The export re-streams each image, hashes the source bytes again while writing a hidden temp file at the share root, and only moves it into place (`link`, so an existing file is never replaced) when the hash is still in Redump; otherwise the temp file is deleted. Redump `.iso` roms go to `DVD/`, `.bin` roms (CD games) to `CD/` with raw 2352-byte sectors unwrapped to 2048-byte user data (Mode 1 / Mode 2 Form 1); audio tracks (`(Track 2+)`) are skipped. Files are named by Redump game name, matching the share's existing files. Exports share the verification drain loop (state in `download_verifications.export_*`), run automatically after a PS2 download verifies unless `GAMARR_PS2_AUTO_EXPORT=false`, and can be retried with `POST /api/downloads/:id/ps2-library`.

**Release search uses disc serials for PS1/PS2.** The game's title (and IGDB alternative names) is matched to Redump retail game names (`titleKey`: parentheses dropped, ` - `/`:` and `&`/`and` folded, `Sims, The` → `The Sims`; demos/betas excluded) to get its serials, USA first. Each torrent indexer is also queried by the first serial (one extra query, failures silent; not usenet, whose posts are obfuscated and where Prowlarr's one-at-a-time pacing would push indexers past gamarr's timeout), and ranking treats a serial in a release title as decisive: the game's own serial is `Strong` (+60), another known game's serial is `Conflicting` (−80), unknown serial-shaped tokens are ignored. The lookup shares verification's Redump source and gives up after 5 s, falling back to title-only search.

### Database

`getDatabase()` in `src/db/client.ts` is a lazy singleton reading `GAMARR_DATABASE_PATH`. It enforces `foreign_keys=ON`, WAL, a 250ms busy timeout, and chmods the directory to `0700` / file to `0600`. `scripts/migrate.mjs` intentionally duplicates that pragma/permission setup because it runs standalone from the container entrypoint, before the app boots, against a trimmed `node_modules`.

better-sqlite3 is **synchronous**: transactions must stay short and must never contain an external `await`. Claim the row first, then do network I/O outside the transaction (see `DownloadService.submit`).

## Invariants worth knowing before editing

**Migrations in `drizzle/` are immutable once committed.** Editing an applied file diverges deployed databases from dev — Drizzle's journal will not re-run it. Always generate a new one. `0002_repair_postprocessing_failures.sql` is a data-repair migration, not just DDL.

**Secrets must never reach the client.** Gamarr sends the Prowlarr API key in the `X-Api-Key` header for URLs it constructs; feed-supplied enclosure credentials are stripped before candidates are persisted. IGDB client secrets and download-client credentials also live only in SQLite. `DownloadUrlPolicyError` deliberately omits the offending URL from the error because those messages surface in user-facing warnings. The settings API returns `Public*Settings` shapes that replace each secret with a `hasClientSecret` / `hasApiKey` boolean — the `*Record` types holding the real values must never be serialized to a response. Do not put URLs or secrets in React Query keys or error reports.

**Mutating routes go through `assertTrustedMutation(request, policy)`** (`src/lib/trusted-mutation.ts`), which enforces the exact scheme/host/port allowlist from `GAMARR_ALLOWED_ORIGINS`, optionally accepts `GAMARR_API_TOKEN` as a bearer for automation, and only honors forwarded headers when `GAMARR_TRUST_PROXY=true`. GET routes for Library and Activity are read-only; refresh, reconcile, connection tests, platform sync, and delete are all guarded non-GET.

**Errors:** throw `AppError` (or the `validationError` / `forbiddenError` helpers) from `src/lib/errors.ts` and let `errorResponse()` in `src/app/api/error-response.ts` serialize it. Anything that is not an `AppError` becomes a generic 500 — never let a raw upstream error message through, since it may carry a key.

**Download submission is idempotent.** The client supplies a `submissionKey`; the service computes a `requestFingerprint` and, on replay, either returns the existing attempt or fails if the same key arrives with different content. What goes into that hash is chosen by the attempt's source, never by which optional fields happen to be present. New attempts use `prowlarr-usenet`, which hashes `[candidateId, gameId, platformId]`, or `prowlarr-torrent` / `internet-archive-torrent`, which append `"torrent"` and the selected file indices sorted ascending (with no selection that is exactly the original `internet-archive-torrent` shape, so legacy rows replay unchanged). The legacy `newznab` and `internet-archive` values remain renderable and keep their original fingerprints: the usenet shape and the stored `iaFileName` respectively. Nothing creates those two. On replay the source is read back from the stored attempt because the candidate it came from has a 30-minute TTL while the attempt row is permanent. The `Unknown` status means an ambiguous SABnzbd or qBittorrent acknowledgement; it is reconciled against the durable `marker` and never resubmitted automatically. `SqliteDownloadRepository.update` is a conditional `UPDATE ... WHERE status NOT IN ('Completed','Failed')`, so once an attempt is terminal no later write lands on it — including a bare progress or file-selection stamp — and a refused write returns the unchanged row rather than throwing.

**Indexer failures are per-indexer.** One Prowlarr indexer failing produces a warning alongside the other indexers' successful results; it must not fail the whole search. Prowlarr discovery failing is different and surfaces as a 502. Download URLs are validated by `url-policy.ts` against the configured Prowlarr origin with credentials and fragments rejected or stripped as appropriate. NZBs and torrent metainfo are size-bounded and never written to disk by Gamarr.

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
| `GAMARR_PROWLARR_MAX_TORRENT_BYTES` | `8388608` (8 MiB) | Ceiling for a `.torrent` metainfo fetch |
| `GAMARR_PROWLARR_BASE_URL` | none | Test-only override of the configured Prowlarr origin |
| `GAMARR_INTERNET_ARCHIVE` | on | Set to `false` to stop searching Internet Archive |
| `GAMARR_IA_BASE_URL` | `https://archive.org` | Test-only override of the Internet Archive origin |
| `GAMARR_DOWNLOAD_PATH_MAP` | none | `client=gamarr` path prefix pairs, comma-separated, e.g. `/downloads=/library,/downloads/games=/library`; without it downloads can't be verified |
| `GAMARR_PS2_LIBRARY_DIR` | none | Writable Open PS2 Loader share (with `DVD/` and `CD/`) that verified PS2 images are copied into; without it the export is off |
| `GAMARR_PS2_AUTO_EXPORT` | `true` | `false` makes PS2 library exports manual (Activity's "Add to PS2 library") |
| `GAMARR_ARCHIVES` | `true` | `false` stops gamarr looking inside `.7z`/`.zip`/`.rar` downloads |
| `GAMARR_SERIAL_SEARCH` | `true` | `false` stops release search looking up disc serials (PS1/PS2) in Redump |
| `GAMARR_7Z_PATH` | `7z` | 7-Zip binary to run |
| `GAMARR_REDUMP_BASE_URL` | libretro-database raw URL | Test-only override of where Redump checksum lists are fetched |
