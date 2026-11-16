# Collection Torrents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the files of a multi-file "collection" torrent, kept in `<config>/collections/<platformId>/`, as release-search results. Grabbing one turns on exactly that file in qBittorrent, then tracks, verifies and exports it on its own.

**Architecture:** A folder adapter behind a new `CollectionsPort` loads and decodes the `.torrent` files. Release search treats each collection as a pseudo-indexer, the way Internet Archive works, and matches files by Redump `titleKey`. A new attempt source, `collection-torrent`, gets its own submit path: add the torrent stopped, zero every file, raise the chosen one, check ownership, then start. It also gets a per-file reconcile branch and a per-file locator branch.

**Tech Stack:** TypeScript, Next.js route handlers, better-sqlite3 + Drizzle, vitest, Playwright, qBittorrent WebAPI (5.3.0).

**Spec:** `docs/superpowers/specs/2026-11-16-collection-torrents-design.md`

## Global Constraints

- Feature code reaches the outside only through ports; `dependencies.ts` binds adapters. `@/integrations/prowlarr/metainfo` is the only allowed integration import from features.
- No `await` inside a better-sqlite3 transaction: claim first, then do network I/O.
- The migrations in `drizzle/` are immutable. Generate a new one with `pnpm db:generate`.
- Errors are `AppError` / `validationError`. User-visible text never contains a URL or secret.
- Status must be shown in text, not only by color (WCAG 2.2 AA).
- qBittorrent target is 5.3.0. Use `stopped=true` and `torrents/start`, with no 4.x fallbacks.
- Info-hashes are lowercase hex v1 (SHA-1 of the bencoded `info` dict).
- `GAMARR_COLLECTIONS_DIR` defaults to `<dirname(GAMARR_DATABASE_PATH)>/collections`.
- Collections are bounded by `GAMARR_PROWLARR_MAX_TORRENT_BYTES` (default 8 MiB).
- At most 25 releases per collection per search.
- Exact user-facing strings:
  - "Other files in this collection are enabled in qBittorrent; set them to Do not download, then retry"
  - "Stopped in qBittorrent"
  - "Torrent was removed from qBittorrent"
  - "Collection torrent changed; search again"
  - "Collection file selection is fixed"

## Review Focus

1. qBittorrent hasn't registered the torrent yet just after `torrents/add`: `torrents/files` returns 404 or `[]` for a moment. The submit must poll briefly (up to 10 s), not fail or start. (Task 6)
2. `&` versus `and`, and `, The` suffixes in file names (`Ratchet & Clank (USA).7z` against IGDB "Ratchet and Clank"): `titleKey` folding must match them. (Task 3)
3. A collection `.torrent` is replaced or deleted between search and grab. The grab fails with "Collection torrent changed; search again" and touches nothing in qBittorrent. (Task 6)
4. A 2,065-file `torrents/files` response (about 600 KB) parses within the 8 MiB response cap, and every file's priority is set with one `filePrio` call, not 2,065 calls. (Task 5)
5. qBittorrent reports the hash in another case, or the torrent is v2-hybrid. Lowercase both sides, and refuse a `.torrent` with an `info.file tree` (v2) at load time with a warning. (Task 1)

---

### Task 1: Info-hash helper and folder collections adapter

**Files:**
- Modify: `src/integrations/prowlarr/metainfo.ts` (add `torrentInfoHash`)
- Modify: `src/features/release-search/ports.ts` (add `Collection`, `CollectionsPort`)
- Modify: `src/features/release-search/models.ts` (add `COLLECTION_INDEXER_PREFIX`, `collectionIndexerId`)
- Create: `src/integrations/collections/folder.ts`
- Test: `src/integrations/prowlarr/metainfo.test.ts`, `src/integrations/collections/folder.test.ts`

**Interfaces:**
- Produces:
  - `torrentInfoHash(bytes: Uint8Array): { hash: string; v2: boolean }`. The hash is lowercase hex, and `v2` is true when `info` has `file tree`.
  - `COLLECTION_INDEXER_PREFIX = "collection:"`
  - `collectionIndexerId(hash: string): string` returns `` `collection:${hash}` ``.
  - The port and its types:
    ```ts
    interface CollectionFile { index: number; name: string; size: number }
    interface Collection { id: string; platformId: number; name: string; torrentFileName: string; files: CollectionFile[] }
    interface CollectionsPort {
      list(platformId: number): { collections: Collection[]; warnings: string[] };
      read(id: string): { collection: Collection; bytes: Uint8Array } | null;
    }
    ```
  - `class FolderCollections implements CollectionsPort { constructor(input: { dir: string; maxBytes: number }) }`

- [ ] **Step 1: Write failing tests**
  - `metainfo.test.ts`:
    - "torrentInfoHash hashes the raw info dict": build a two-file torrent with the existing test bencoder and expect the SHA-1 of its exact `info` byte slice.
    - "flags v2 file tree": expect `v2: true`.
  - `folder.test.ts` uses `mkdtemp` and writes fixtures with Node `fs`:
    - "lists collections for the platform folder only": files in `8/` and `9/`; `list(8)` returns only the `8/` one, with `platformId: 8`.
    - "file names drop the torrent root": a file `name` is `"007 - Nightfire (USA).7z"`, not `"<root>/…"`. Strip the leading `info.name/` that `decodeTorrentFiles` adds.
    - "warns and skips": a top-level `.torrent`, a symlink, an oversize file (`maxBytes` 10), a malformed file and a v2 file each add one warning containing the file name, and none of them appear in `collections`.
    - "dedupes by hash, first name wins".
    - "caches by mtime and size": spy on `readFile` and expect one call across two `list(8)` calls; after rewriting with a new mtime, expect two.
    - "read returns bytes by id, null for unknown".
- [ ] **Step 2:** Run `pnpm test src/integrations/prowlarr/metainfo.test.ts src/integrations/collections/folder.test.ts`. Expected: FAIL (not defined).
- [ ] **Step 3: Implement.**
  - `torrentInfoHash` re-walks the bencode to find the byte span of the `info` value, the same reader `decodeTorrentFiles` uses.
  - `FolderCollections`:
    - only reads entries whose directory name is `/^\d+$/`;
    - uses `lstat` and skips anything that isn't a regular file;
    - caches by `path → {mtimeMs, size, result}`;
    - `read(id)` re-reads the file from disk so the grab gets current bytes.
- [ ] **Step 4:** Run the same tests. Expected: PASS. Also run `pnpm typecheck`.
- [ ] **Step 5:** Commit: `feat(collections): folder adapter and info-hash helper`.

### Task 2: Fetch routing and wiring for collections

**Files:**
- Create: `src/integrations/collections/fetch.ts`
- Modify: `src/integrations/internet-archive/fetch.ts` (`routeReleaseFetch` gains `collections`)
- Modify: `src/app/api/releases/dependencies.ts`, `src/app/api/downloads/dependencies.ts`
- Create: `src/lib/collections-dir.ts`
- Test: `src/integrations/collections/fetch.test.ts`, `src/integrations/internet-archive/fetch.test.ts`, `src/lib/collections-dir.test.ts`

**Interfaces:**
- Consumes: `CollectionsPort` and `COLLECTION_INDEXER_PREFIX` (Task 1).
- Produces:
  - `class CollectionTorrentFetcher { constructor(port: CollectionsPort); fetch(req): Promise<{kind:"torrent"; bytes}> }`. It reads the bytes by `sourceSnapshot.collectionId` and throws `validationError("Collection torrent changed; search again")` when `read` returns null or the snapshot's `fileIndex` or `fileName` no longer matches.
  - `routeReleaseFetch({ prowlarr, internetArchive, collections: ReleaseFetcher | null })`, which sends any candidate whose `indexerId` starts with `collection:` to `collections`.
  - `collectionsDir(env = process.env): string`
  - `collectionsPort(): CollectionsPort`, a singleton in `src/app/api/releases/dependencies.ts`, exported for downloads and search.

- [ ] **Step 1: Write failing tests**
  - "routes collection candidates to the collections fetcher".
  - "a collection candidate with collections null → 503 'Collections are disabled'".
  - "changed file at index → 'Collection torrent changed; search again'".
  - "collectionsDir defaults next to the database": with `GAMARR_DATABASE_PATH=/config/gamarr.db`, expect `/config/collections`, and the env override wins.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement and wire both `dependencies.ts` files.
- [ ] **Step 4:** Run `pnpm test src/integrations src/lib` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(collections): route collection candidates to the folder`.

### Task 3: Collection results in release search

**Files:**
- Create: `src/features/release-search/collections.ts` (pure matching)
- Modify: `src/features/release-search/service.ts`
- Modify: `src/features/release-search/release-results.tsx`, `src/features/release-search/download-dialog.tsx`
- Test: `src/features/release-search/collections.test.ts`, `src/features/release-search/service.test.ts`, `src/features/release-search/download-dialog.test.tsx`

**Interfaces:**
- Consumes: `CollectionsPort` (Task 1), `titleKey` from `@/features/verification/redump`, `DiscSerials.gameFor`.
- Produces:
  - `matchCollectionFiles(collection: Collection, titles: string[], redumpNames: string[], limit = 25): CollectionFile[]`. It compares the `titleKey` of each file's base name without its extension against the keys of `titles` ∪ `redumpNames`, in file-index order.
  - `ReleaseSearchDependencies.collections?: CollectionsPort | null`
  - The candidate `sourceSnapshot` for a collection is `{ indexerName, collectionId, torrentFileName, fileIndex, fileName, origin: null, magnetUrl: null }`.

- [ ] **Step 1: Write failing tests**
  - `collections.test.ts`:
    - "matches by title, alternative name and Redump name";
    - "folds & and , The": `Ratchet & Clank (USA).7z` matches "Ratchet and Clank";
    - "keeps both discs": `X (USA) (Disc 1).7z` and `(Disc 2)`;
    - "does not match a sequel": "Burnout" doesn't match `Burnout 2 - Point of Impact (USA).7z`;
    - "caps at 25".
  - `service.test.ts`:
    - "collection releases rank with the preferred-source bonus and carry the collection name";
    - "a broken collection is a warning only";
    - "another platform's collections are not searched";
    - "listCandidateFiles returns only the chosen file for a collection candidate", with the expected `files: [{ index: 3, name: "007 - Nightfire (USA).7z", size }]`.
  - `download-dialog.test.tsx`: "collection release shows 'Gamarr will turn on <file> in <collection>' and no checkboxes".
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `search`, after `lookupSerials`, call `collections.list(platformId)`.
  - Register each collection in `indexerById` as `{ id: collectionIndexerId(hash), name, protocol: "torrent", priority: 0, categoryIds: [] }`.
  - Push releases ranked with `preferredSource: collection.name`. Each release has `guid: collection:<hash>:<index>` and `downloadUrl: collection:<hash>/<index>`.
  - Save the candidates with a `saveCollectionCandidate` alongside `saveInternetArchiveCandidate`, skipping `validateDownloadUrl`.
  - The candidate's `downloadPath` is `` `/collection/${hash}/${index}` ``.
  - The dialog knows a collection candidate from the `files` response having exactly one file and `collection: { name }`. Add `collection?: { name: string }` to `CandidateFilesResponse`.
- [ ] **Step 4:** Run `pnpm test src/features/release-search` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(search): list collection files as releases`.

### Task 4: `collection-torrent` attempt source

**Files:**
- Modify: `src/features/downloads/models.ts`, `src/db/schema.ts`
- Create: `drizzle/0009_*.sql` (generated)
- Modify: `src/features/downloads/service.ts` (`fingerprintParts`)
- Modify: `src/features/downloads/repository.ts` (`recoverStaleSubmitting`)
- Modify: `src/features/library/activity-screen.tsx` (source label)
- Test: `src/features/downloads/repository.test.ts`, `src/features/downloads/service.test.ts`, `src/features/library/activity-screen.test.tsx`

**Interfaces:**
- Produces:
  - `AttemptSourceType` gains `"collection-torrent"`.
  - Its fingerprint is `[candidateId, gameId, platformId, "torrent", fileIndex]`, where `fileIndex` is read from the candidate snapshot on claim and from `selectedFiles[0].index` on replay.
  - `recoverStaleSubmitting` sets `collection-torrent` rows to `Failed` with "Submission state was uncertain after restart", and other sources to `Unknown` as before.

- [ ] **Step 1: Write failing tests**
  - "schema accepts collection-torrent": insert through the repository.
  - "stale collection submission fails, others become Unknown".
  - "Activity labels a collection attempt '<collection> (collection)'": the label is text.
- [ ] **Step 2:** Run them. Expected: FAIL (CHECK constraint).
- [ ] **Step 3:** Add `'collection-torrent'` to the `download_attempts_source_valid` CHECK, then run `pnpm db:generate` and review the SQL (a table rebuild for the CHECK). Update the model, the fingerprint and the repository.
- [ ] **Step 4:** Run `GAMARR_DATABASE_PATH=./data/test.db pnpm db:migrate`, then `pnpm test src/features/downloads src/features/library`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(downloads): collection-torrent attempt source`.

### Task 5: qBittorrent client additions

**Files:**
- Modify: `src/features/downloads/port.ts`, `src/integrations/qbittorrent/client.ts`
- Test: `src/integrations/qbittorrent/client.test.ts`

**Interfaces:**
- Produces, on `TorrentClientPort`:
  - `add(input: {...; stopped?: boolean})`, which sends form field `stopped=true` when set.
  - `listFiles(hash): Promise<Array<{ index: number; name: string; progress: number; priority: number }>>`. `progress` is 0..1 as returned.
  - `setFilePriorities(hash, indices, priority: 0 | 1)`
  - `addTags(hash: string, tag: string): Promise<void>`, which calls `torrents/addTags`.
  - `start(hash: string): Promise<void>`, which calls `torrents/start`.
  - `TorrentJob.savePath?: string`, from `save_path`.
  - `listFiles` throws `AppError("NOT_FOUND", 404, …)` on HTTP 404, so the caller can tell "not registered yet" apart from other failures.

- [ ] **Step 1: Write failing tests (MSW).**
  - "add sends stopped=true";
  - "listFiles maps progress and priority";
  - "listFiles 404 → NOT_FOUND";
  - "setFilePriorities sends one request with `id` joined by `|` for 2,065 indices";
  - "parses a 2,065-file response";
  - "addTags and start post the hash";
  - "list maps save_path".
- [ ] **Step 2:** Run `pnpm test src/integrations/qbittorrent`. Expected: FAIL.
- [ ] **Step 3:** Implement, following the existing request, error and zod patterns in `client.ts`.
- [ ] **Step 4:** Run the tests, then `pnpm typecheck` (fix the fakes in other tests). Expected: PASS.
- [ ] **Step 5:** Commit: `feat(qbittorrent): stopped add, file progress, tags, start`.

### Task 6: Submitting a collection grab

**Files:**
- Modify: `src/features/downloads/service.ts` (add `submitCollection`, branched from `submit` on the `collection:` prefix)
- Test: `src/features/downloads/service.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 and 5.
- Produces: `DownloadServiceDependencies.sleep?: (ms: number) => Promise<void>`, for the poll. Tests inject a no-op.

- [ ] **Step 1: Write failing tests** (a fake `TorrentClientPort` that records its calls in order)
  - "fresh add: add(stopped) → filePrio(all,0) → filePrio([i],1) → start; attempt Downloading, torrentHash = info-hash, selectedFiles = [{index,name}], filesAppliedAt set".
  - "polls listFiles through NOT_FOUND/empty until files appear (≤10 s) and fails with nothing started if they never do".
  - "already loaded: addTags then filePrio([i],1) then start; no add; no priority lowered".
  - "add rejected 409 → already-loaded path".
  - "unowned file wanted → Failed with the exact 'Other files…' text, start never called". Two variants: a hand-loaded torrent, and a file owned by a *Completed* attempt, which still counts as owned.
  - "file name at index differs → Failed 'Collection torrent changed; search again', no qBittorrent calls after files".
  - "selectedFiles in the request → validation error 'Collection file selection is fixed'".
  - "replay with the same submissionKey returns the attempt unchanged".
- [ ] **Step 2:** Run `pnpm test src/features/downloads/service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `submitCollection(input, candidate)`.**
  - Claim with the source `collection-torrent` and `torrentHash` set from the snapshot hash.
  - Fetch the bytes through `releaseFetcher`, then follow the spec's steps 1–7.
  - "Owned" means a `collection-torrent` attempt on this hash that isn't `Failed`, whose `selectedFiles[0].index` is that file. Add a `repository.listByTorrentHash(hash)`.
  - Every exception after the add leaves the torrent stopped: never call `start` in a `finally`.
- [ ] **Step 4:** Run the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(downloads): submit collection grabs one file at a time`.

### Task 7: Per-file reconcile and locator

**Files:**
- Modify: `src/features/downloads/service.ts` (`reconcileTorrents`)
- Modify: `src/features/verification/service.ts` (`ClientDownloadLocator.locate`)
- Test: `src/features/downloads/service.test.ts`, `src/features/verification/service.test.ts`

**Interfaces:**
- Consumes: `listFiles` with progress and `TorrentJob.savePath` (Task 5).
- Produces: none new.

- [ ] **Step 1: Write failing tests**
  - These are the spec's state table rows, one test each:
    - file progress 1 while the torrent is `stalledDL` (another game still going) → Completed, 100;
    - `error` / `missingFiles` → Failed for both attempts on the hash;
    - `stoppedDL` with progress 0.4 → Downloading, 40, detail "Stopped in qBittorrent";
    - `downloading` with 0.4 → Downloading, 40, detail null;
    - hash absent → Failed "Torrent was removed from qBittorrent".
  - "two attempts on one torrent complete independently".
  - "never calls setFilePriorities for collection attempts".
  - Locator: "collection attempt locates `<savePath>/<file name>`", for example `savePath` `/downloads` with file `My Sony PlayStation 2 (USA) Collection/007 - Nightfire (USA).7z`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Branch on `collection-torrent` before the existing torrent logic.
  - Call `listFiles` once per distinct hash per reconcile.
  - "Stopped in qBittorrent" lives in `failureDetail` for this one non-failed state. The Activity screen already shows `failureDetail` as text.
- [ ] **Step 4:** Run `pnpm test src/features/downloads src/features/verification`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(downloads): per-file progress and location for collections`.

### Task 8: End-to-end test and docs

**Files:**
- Modify: `tests/provider-server/server.ts`, `tests/provider-server/state.ts` (add `torrents/files`, `filePrio`, `addTags`, `start`, and record call order)
- Create: `tests/e2e/collection-grab.spec.ts`, plus a fixture `tests/fixtures/collections/8/ps2-test.torrent` (two files, built by a small script under `tests/fixtures/`)
- Modify: `playwright.config.ts` (`GAMARR_COLLECTIONS_DIR` points at the fixture folder)
- Modify: `CLAUDE.md` (env-table row for `GAMARR_COLLECTIONS_DIR`, and a "Collections" paragraph after the Internet Archive one)

- [ ] **Step 1: Write the failing e2e test.** Search a PS2 game whose title matches the fixture's file, grab it, and assert that the stub recorded `add(stopped=true)` → `filePrio 0 (all)` → `filePrio 1 ([i])` → `start`. Also check that Activity shows the collection label as text, and that axe passes.
- [ ] **Step 2:** Run `pnpm exec playwright test tests/e2e/collection-grab.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Extend the stub server and the config, and write the docs.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`. Expected: all PASS.
- [ ] **Step 5:** Commit: `test(e2e): collection grab; docs: collections`.
