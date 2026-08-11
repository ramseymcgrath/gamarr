# Prowlarr Torrent Indexers Design

## Summary

Replaces Gamarr's hand-configured Newznab indexer list and its bespoke Internet
Archive integration with a single Prowlarr connection. Gamarr discovers every
indexer Prowlarr has enabled, searches them all, and routes each result by
protocol: torrents to qBittorrent, usenet to SABnzbd.

The operator configures one base URL and one API key. Enabling an indexer in
Prowlarr makes it searchable in Gamarr with no further configuration, and the
`indexers` table, its CRUD API, and its settings UI are deleted.

This is a refactor, not an addition. It removes two integrations
(`src/integrations/newznab/`, `src/integrations/internet-archive/`), one table
and one join table, five environment variables, and the per-source branching
that the Internet Archive work introduced — while replacing "torrent" as a
special case with `protocol` as an ordinary field on a release.

## Goals

- Search every torrent indexer configured in Prowlarr, not just the Internet
  Archive.
- Keep usenet working through the same pipeline, routed by protocol rather than
  by a parallel code path.
- Reduce indexer configuration to one connection.
- Preserve existing download history across the migration.
- Keep per-file selection working, now for any torrent rather than only for
  Internet Archive items.

## Non-goals

- Automatic release selection, monitoring, or a background scheduler. The v1
  non-goals stand: the operator picks every download by hand.
- Managing Prowlarr from Gamarr. Adding, editing, testing or disabling an
  indexer happens in Prowlarr. Gamarr reads the list; it never writes it.
- Prowlarr's aggregate `/api/v1/search` endpoint. Per-indexer fan-out is kept
  so a single failing or slow indexer stays a warning beside the others'
  results rather than degrading one opaque response.
- A second torrent client. `TorrentClientPort` already makes Transmission
  additive later.
- Seeding policy, ratio limits, torrent removal, or save-path override.
- Retaining direct server-side file downloads. Every payload is now delivered
  by SABnzbd or qBittorrent; Gamarr no longer writes downloaded bytes to disk.

## Upstream facts this design depends on

- `GET /api/v1/indexer` returns every configured indexer with `id`, `name`,
  `protocol` (`"torrent"` or `"usenet"`), `enable`, `priority`, and
  `capabilities.categories`. Authenticated by an `X-Api-Key` header.
- `GET /api/v1/indexer/{id}/newznab?t=search&q=…&cat=…` returns a
  Newznab/Torznab RSS document for that one indexer. Torznab documents carry
  `seeders` and `peers` attributes, may carry a `magneturl` attribute, and use
  an `application/x-bittorrent` enclosure type.
- `GET /api/v1/indexer/{id}/download?link=…` proxies the actual NZB or torrent
  fetch. Every enclosure URL Prowlarr emits points at this endpoint on the
  Prowlarr origin, which is why the existing same-origin download policy
  carries over unchanged.
- For a tracker that publishes no `.torrent`, that download endpoint answers
  `302` with a `magnet:` URI in `Location`.
- qBittorrent's `torrents/add` accepts either a `.torrent` file part or a
  `urls` field holding a magnet URI, and `torrents/filePrio` sets per-file
  priority by index once the torrent's metadata is known.

## Data model

### `Release` (`src/features/release-search/models.ts`)

`source: ReleaseSourceType` is removed — there is now exactly one release
source. It is replaced by:

```ts
protocol: "usenet" | "torrent";
seeders: number | null;
peers: number | null;
magnetUrl: string | null;
```

`indexerId` holds Prowlarr's numeric indexer id as text. `indexerName` holds
Prowlarr's own label, so Activity and Library keep reading naturally without a
lookup.

`ReleaseSourceType`, `INTERNET_ARCHIVE_INDEXER_ID`,
`INTERNET_ARCHIVE_INDEXER_NAME`, `NewznabSearchResult`, `InternetArchiveItem`,
`InternetArchiveFile`, `InternetArchiveSearchResult` and `ItemTorrent` are all
deleted. `ItemTorrent`'s role is taken by a `TorrentFile { name, size, index }`
list decoded from metainfo.

### `AttemptSourceType` (`src/features/downloads/models.ts`)

```ts
export type AttemptSourceType =
  | "prowlarr-usenet"
  | "prowlarr-torrent"
  // Legacy: written before the Prowlarr refactor. Rendered, never created.
  | "newznab"
  | "internet-archive"
  | "internet-archive-torrent";
```

The three legacy values exist so Library and Activity keep rendering history
written before the migration. Nothing may create them, and the check constraint
on `download_attempts.source` permits all five.

### Migration `0006`

Five steps, in this order. Steps 3 and 4 are SQLite table rebuilds and run
inside the standard 12-step procedure with `PRAGMA foreign_keys=OFF` for the
duration of the migration only.

1. `CREATE TABLE prowlarr_settings` — a singleton row shaped like
   `sabnzbd_settings`: `base_url`, `api_key`, `timeout_ms`, `config_revision`,
   `last_test_status`, `last_tested_at`, `updated_at`. A
   `prowlarr_timeout_range` check mirrors `indexers_timeout_range`
   (1000–30000ms).
2. `CREATE TABLE platform_categories (platform_id, category_id)` with a
   composite primary key and a cascading FK to `platforms`, populated by
   `INSERT ... SELECT DISTINCT platform_id, category_id FROM
   platform_indexer_categories`. Existing category choices survive; they stop
   being per-indexer.
3. Rebuild `release_candidates`: drop the FK to `indexers`, add `protocol` and
   `seeders`, replace the `release_candidates_source_valid` check with a
   `release_candidates_protocol_valid` check over `('usenet','torrent')`, and
   drop the now-meaningless `source` column. Recreated empty — the table is a
   30-minute TTL cache and holding nothing is correct.
4. Rebuild `download_attempts` preserving every row. The rebuild exists solely
   to drop the `indexer_id` FK to `indexers`; the column itself stays as free
   text. Also adds nullable `selected_files` (JSON array of
   `{ index, name }` pairs) and `files_applied_at` (integer), and widens the
   source check to the five values above. `ia_file_name` stays as a read-only
   legacy column.

   The client submits indices only; the server resolves each index to a name
   from the metainfo it fetched anyway and stores both, so the name used for
   verification at apply time is server-derived and cannot be forged by the
   caller.
5. `DROP TABLE platform_indexer_categories`, then `DROP TABLE indexers`.

Step 4 is the only genuinely risky step: it rewrites the table holding download
history that has already survived two prior migrations. It gets a dedicated
test asserting row-for-row preservation against a seeded fixture containing
rows of all three legacy source values.

### Marker naming

The `sab_marker` column has been dual-purpose since Internet Archive torrents
shipped — it is the SABnzbd marker for usenet and the qBittorrent tag for
torrents. The TypeScript field is renamed `marker` while the column name stays
`sab_marker`, so the type stops misleading without costing a migration.

## Ports and adapters

### `ProwlarrPort` (`src/features/release-search/ports.ts`)

Replaces `NewznabPort`, `NewznabClientFactory`, `ListReleaseIndexersPort` and
`InternetArchiveSearchPort` outright.

```ts
export interface ProwlarrIndexer {
  id: string;
  name: string;
  protocol: "usenet" | "torrent";
  priority: number;
  categoryIds: string[];
}

export interface ProwlarrPort {
  listIndexers(signal: AbortSignal): Promise<ProwlarrIndexer[]>;
  search(
    indexer: ProwlarrIndexer,
    query: PlannedQuery,
    signal: AbortSignal
  ): Promise<{ releases: Release[]; warnings: string[] }>;
}
```

`listIndexers` returns only indexers with `enable === true`; the filter lives
in the adapter because "enabled" is Prowlarr's concept, not the domain's.

### `ReleaseFetcherPort` (`src/features/downloads/port.ts`)

Replaces `NzbFetcherPort`. The discriminated return is where the magnet
fallback lands without leaking a transport concern into the service.

```ts
export type FetchedRelease =
  | { kind: "nzb"; bytes: Uint8Array }
  | { kind: "torrent"; bytes: Uint8Array }
  | { kind: "magnet"; uri: string };

export interface ReleaseFetcherPort {
  fetch(input: {
    candidate: ReleaseCandidateRecord;
    magnetUrl: string | null;
    maxBytes: number;
  }): Promise<FetchedRelease>;
}
```

The `indexer: IndexerRecord` parameter is gone — credentials now come from the
single Prowlarr settings record, resolved inside the adapter.

The whole candidate is passed rather than a narrowed subset because
`candidate.guid` is load-bearing: it is what
`getApprovedRedirectOrigin` binds the one permitted external redirect origin to.
`magnetUrl` is a separate parameter rather than a candidate field because it
lives inside `sourceSnapshot`, and the fetcher must not parse that blob.

The approved-origin handoff survives this refactor unchanged. A Prowlarr
indexer configured with `redirect: true` answers the download endpoint with a
302 to the tracker instead of proxying, so the existing rule still applies: a
redirect may move at most once, only to an origin the feed already named in the
release GUID, with the API key stripped and DNS pinned before the socket opens.

`InternetArchiveDownloadPort`, `InternetArchiveDownloadConfig` and
`InternetArchiveTorrentConfig` are deleted.

### `TorrentClientPort` (`src/features/downloads/port.ts`)

```ts
add(input: {
  payload: { torrent: Uint8Array; filename: string } | { magnet: string };
  category: string | null;
  tag: string;
}): Promise<{ hash: string | null }>;
listFiles(hash: string): Promise<Array<{ index: number; name: string }>>;
setFilePriorities(
  hash: string,
  indices: number[],
  priority: 0
): Promise<void>;
```

`list()` and `testConnection()` are unchanged. `add` keeps returning a nullable
hash: qBittorrent WebAPI builds before 2.14.0 answer with a bare `Ok.`, and
those attempts are still matched by tag.

### `src/integrations/prowlarr/`

| File | Responsibility |
| --- | --- |
| `client.ts` | `ProwlarrPort` implementation: discovery and per-indexer search |
| `feed.ts` | Newznab/Torznab RSS → `Release[]`, lifted from `newznab/client.ts` |
| `fetch.ts` | Bounded fetch with a manual redirect chain, lifted from `newznab/download.ts` |
| `url-policy.ts` | Same-origin validation against the Prowlarr base URL, lifted unchanged |
| `magnet-policy.ts` | New. Validates `magnet:` URIs |
| `metainfo.ts` | New. Minimal bencode decoder → torrent file list |

`src/integrations/newznab/` and `src/integrations/internet-archive/` are
deleted in full.

## Request path

### `GET /api/releases` (search)

`ReleaseSearchService.search` keeps its shape; only the fan-out source changes.

1. Resolve game and platform. Unchanged.
2. `prowlarr.listIndexers(signal)`, inside the overall deadline. On failure,
   throw `AppError("UNAVAILABLE", 502, "Prowlarr is unavailable")` — see
   *Failure handling*.
3. Fan out over every enabled indexer at concurrency 4, as today. The overall
   deadline formula is unchanged — `min(60s, max(20s, 5s + n × 2.5s))` — but
   `n` now comes from discovery rather than from a curated table, so a
   Prowlarr with 40 indexers pins it at the 60s ceiling.
4. Rank each release with `rankRelease`, unchanged: title, year and category
   evidence only.
5. Deduplicate, mint candidates, return.

Every enabled indexer is searched regardless of which download client is
configured. The response instead carries `usenetClientConfigured` and
`torrentClientConfigured` booleans, following the precedent already set by
`torrentClientConfigured` in `CandidateFilesResponse`: an available release is
never hidden because delivery is off — the dialog explains it.

#### Category derivation

Today the query categories are `platform.categoryIds ∪ indexer.categoryIds`.
They become `platform.categoryIds` filtered to what the indexer advertises in
`capabilities.categories`, because sending an unsupported `cat` to a Cardigann
tracker yields an empty result set rather than an error.

An indexer satisfies a platform category `C` if it advertises `C`, or
advertises any category in the same thousand-block as `C` when `C` is a block
root (`1000` is satisfied by `1010` or `1020`), or advertises `C`'s block root.
An empty intersection means the `cat` parameter is omitted entirely and the
indexer is searched unfiltered.

#### Deduplication and ordering

`deduplicateReleases` is unchanged in how it groups. What changes is that
cross-tracker duplicates are now the norm rather than the exception, so
ordering *within* a group is specified: seeders descending, then Prowlarr's
`priority` ascending, then `publishedAt` descending. `PublicReleaseSource`
gains `protocol` and `seeders` so the UI can show the health of each tracker
carrying the same release.

Seeders participate in ordering only. They never enter `rankRelease`, so match
class keeps meaning "is this the right game" and stays independent of "is this
download healthy": a well-seeded wrong release stays `Conflicting`, and a
single-seeder correct release stays `Strong`.

#### Candidates

Candidates persist `protocol` and `seeders` alongside the existing fields, and
a feed-supplied `magnetUrl` when present, carried in the existing
`sourceSnapshot` JSON rather than a new column since only torrent candidates
have one.
`indexerConfigRevision` now reads the Prowlarr settings revision, so changing
the Prowlarr URL or key invalidates in-flight candidates exactly the way
changing an indexer used to. `downloadPath` is still the credential-stripped
path produced by `validateDownloadUrl`.

### `GET /api/releases/files`

The endpoint survives; its backing changes from Internet Archive metadata to
torrent metainfo.

- Torrent candidate whose enclosure resolves to a `.torrent`: fetch the
  metainfo bounded by `GAMARR_PROWLARR_MAX_TORRENT_BYTES`, bdecode it, and
  return `TorrentFile[]` from `info.files` (or a single entry from `info.name`
  for a single-file torrent).
- Torrent candidate that resolves to a magnet: return an empty file list with
  `metadataPending: true`. A magnet has no file list before it is added, so the
  dialog offers a whole-torrent grab and says why, rather than showing a
  selector that cannot work.
- Usenet candidate: `validationError` — NZBs have no selectable files.

Expiry and absence still collapse into a single 404 so the endpoint cannot be
used as an existence oracle for candidate IDs.

### `POST /api/downloads`

`SubmitDownloadInput` drops `delivery` (there is no longer a per-item choice
between file and torrent) and replaces `fileName?: string` with
`selectedFiles?: number[]` — metainfo indices, not names, so nothing the client
sends can become a path.

## Download lifecycle

### Usenet

Behaviourally unchanged: claim the attempt, fetch bounded NZB bytes, upload to
SABnzbd, reconcile against the durable marker.

### Torrent

Follows the durable-claim pattern the Internet Archive torrent path
established.

1. **Claim.** Inside the short transaction, write a `Pending` attempt. No
   external `await` occurs inside the transaction.
2. **Fetch.** Outside the transaction, `fetch.ts` resolves the payload. When
   the candidate already carries a `magnetUrl` — many Torznab feeds publish a
   `magneturl` attribute directly — it is validated by `magnet-policy` and
   returned as `{ kind: "magnet", uri }` with no HTTP request at all. Otherwise
   the enclosure URL is requested with the API key re-attached from settings,
   bounded by `GAMARR_PROWLARR_MAX_TORRENT_BYTES`: `200` with an
   `application/x-bittorrent` body yields `{ kind: "torrent", bytes }`; `302`
   with a `magnet:` `Location` yields `{ kind: "magnet", uri }` after the same
   policy validation; every other response falls through the existing hardened
   redirect rules unchanged.
3. **Add.** `qbittorrent.add({ payload, category, tag: marker })`. A
   `TorrentAddError` with outcome `ambiguous` lands as `Unknown` and is
   reconciled later, never resubmitted — the existing semantics.

### Fingerprints

The rule stands that what goes into the hash is chosen by the candidate's
*source*, never by which optional fields happen to be present:

| Source | Hashed |
| --- | --- |
| `prowlarr-usenet` | `[candidateId, gameId, platformId]` |
| `prowlarr-torrent` | `[candidateId, gameId, platformId, "torrent", ...selectedFiles]` |
| `newznab` (legacy) | `[candidateId, gameId, platformId]` |
| `internet-archive` (legacy) | `[candidateId, gameId, platformId, fileName]` |
| `internet-archive-torrent` (legacy) | `[candidateId, gameId, platformId, "torrent"]` |

`selectedFiles` is empty for a whole-torrent grab and is sorted ascending
before hashing so the same selection in a different order replays as the same
request. The three legacy rows keep their original hashing untouched, so rows
in deployed databases still replay-match. On replay the source is read back off
the stored attempt, because the candidate that produced it has a 30-minute TTL
while the attempt row is permanent — and for a legacy `internet-archive` row
the `fileName` component is likewise read from the attempt's `ia_file_name`
column, never from the replayed input, which no longer carries it.

### File selection

File selection runs on the reconcile pass, not at submit. qBittorrent does not
know a magnet's file list until metadata arrives, and even a `.torrent` is not
listable the instant it is added.

The attempt carries `selected_files` and `files_applied_at`. On each reconcile
tick, for every non-terminal torrent attempt with a non-empty `selected_files`
and a null `files_applied_at`:

1. Resolve the hash — from `torrentHash`, or by matching `marker` against tags
   in the `list()` result already fetched for reconcile.
2. `listFiles(hash)`. An empty list means metadata has not arrived; skip and
   retry next tick.
3. `setFilePriorities(hash, unselectedIndices, 0)`, then stamp
   `files_applied_at`. When the selection covers every file the unselected set
   is empty; stamp `files_applied_at` and make no client call.

One code path for both payload kinds, and it survives a restart mid-application
because the intent is durable on the attempt.

This rests on one upstream assumption worth naming, because it is what makes an
index chosen from metainfo meaningful to qBittorrent: qBittorrent enumerates a
torrent's files in the order the metainfo `info.files` list declares them, so
index `n` refers to the same file in both. `listFiles` returns names alongside
indices, and the reconcile step verifies the name at each selected index still
matches what the dialog offered before writing priorities. A mismatch aborts
the application, stamps nothing, and records a warning rather than silently
deprioritising the wrong file.

### Reconcile

`reconcileTorrents` generalises from Internet Archive torrents to every
`prowlarr-torrent` attempt. Matching is unchanged: by `torrentHash` when
present, by tag membership when the client returned no hash. The file-selection
step above runs in the same pass.

`SqliteDownloadRepository.update` remains a conditional
`UPDATE … WHERE status NOT IN ('Completed','Failed')`, so once an attempt is
terminal no later write lands on it — including a `files_applied_at` stamp.

### Recovery

Startup recovery loses its Internet Archive direct-download branch entirely.
Torrents survive a restart by design and are picked up by the next reconcile;
there is nothing left that needs failing on boot except leftovers. Any
in-flight legacy `internet-archive` (direct) attempt is failed once on the
first boot after the upgrade, with `failureDetail` explaining that the direct
download path was removed.

## Settings

`indexers` CRUD is replaced by a single Prowlarr connection.

```ts
export const prowlarrSettingsInputSchema = z.object({
  baseUrl: z.url(),
  apiKey: secretUpdateSchema,
  timeoutMs: z.number().int().min(1_000).max(30_000)
});

export interface PublicProwlarrSettings {
  baseUrl: string;
  hasApiKey: boolean;
  timeoutMs: number;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
}
```

`PublicSettings.indexers: PublicIndexer[]` becomes
`PublicSettings.prowlarr: PublicProwlarrSettings | null`. `IndexerRecord`,
`PublicIndexer` and `indexerInputSchema` are deleted.

Test connection calls `GET /api/v1/indexer` and reports the discovered list
read-only — name, protocol and priority per indexer, plus a count by protocol.
It is the same guarded non-GET route shape as the SABnzbd and qBittorrent
tests. The discovered list is never persisted; it is display output from the
test, and search re-discovers on every request.

Platform category editing moves from per-platform-per-indexer to per-platform,
backed by the new `platform_categories` table.

## User experience

`settings-screen.tsx` and `setup-screen.tsx` lose the indexer list and its
add/edit/delete flow, and gain a single Prowlarr card matching the existing
SABnzbd and qBittorrent cards. After a successful test the card lists the
discovered indexers read-only, with a line explaining that indexers are managed
in Prowlarr.

`release-results.tsx` gains a protocol indicator and a seeder count per source.
Per WCAG 2.2 AA and the existing project requirement, protocol encodes meaning
in text and shape, never colour alone — the same rule match rank already
follows.

`download-dialog.tsx`:

- Usenet release: submit directly, no file list.
- Torrent release with metainfo: the existing file selector, now listing
  torrent contents. Selecting nothing means the whole torrent.
- Torrent release from a magnet: no selector, with a plain statement that the
  whole torrent will be added because the file list is not known until metadata
  arrives.
- Release whose client is not configured: shown, disabled, with the reason.

## Failure handling and security

**Per-indexer isolation is unchanged.** One indexer failing or timing out
produces a warning beside the other indexers' results and must not fail the
search.

**Discovery failure is different in kind.** There is no fan-out to degrade, and
an empty result list would read as "nothing found" when it means "Prowlarr is
down". Discovery failure therefore throws
`AppError("UNAVAILABLE", 502, "Prowlarr is unavailable")`.

**The Prowlarr API key inherits every rule the Newznab keys had.**
`PublicProwlarrSettings` exposes `hasApiKey`, never the value. Requests Gamarr
constructs use the `X-Api-Key` header rather than a query parameter, so the key
never enters a URL that Gamarr builds or that could reach a log. Enclosure URLs
*from* Prowlarr do embed `apikey`, which is exactly what `validateDownloadUrl`
already strips before persisting `downloadPath`; it is re-attached from
settings at fetch time. `DownloadUrlPolicyError` still never carries the
offending URL, because those messages surface in user-facing warnings.

**Magnet policy** (`magnet-policy.ts`) requires the `magnet:` scheme exactly,
requires an `xt=urn:btih:` topic whose infohash is 40 hex or 32 base32
characters, rejects any `xt` that is not `btih`, and caps total URI length at
4 KiB. It also runs the credential check `removeIndexerCredentials` performs: a
redirect that echoes the Prowlarr API key into a magnet is rejected rather than
forwarded to qBittorrent.

**Metainfo policy** (`metainfo.ts`) decodes bencode from input already capped
at 8 MiB, with a nesting depth limit, and rejects a non-dict root or trailing
garbage. It reads only `info.name`, `info.files[].path` and
`info.files[].length`. Path traversal is not a filesystem risk here — Gamarr no
longer writes any downloaded bytes, and file selection is sent to qBittorrent
by index, never by path — so names are surfaced verbatim and React escapes
them.

**SSRF posture is unchanged.** `fetch.ts` keeps resolving and pinning DNS and
rejecting metadata, private, link-local, multicast, loopback, unspecified and
reserved destinations, with the existing carve-out that the *configured* origin
may be RFC1918. That carve-out is now the normal case, since Prowlarr sits on
the LAN.

**Mutating routes** keep going through `assertTrustedMutation`. Settings write,
connection test, and download submit are all guarded non-GET; release search
and file listing stay read-only GETs.

**Non-`AppError` throws** still become a generic 500. No upstream error message
is passed through, since it may carry a key.

## Testing

Three of the four new modules are pure, so they are tested first and in
isolation.

- `magnet-policy.test.ts` — table-driven over valid forms, wrong scheme,
  non-`btih` `xt`, malformed infohash, over-length, and the key-echo rejection.
- `metainfo.test.ts` — single-file, multi-file, truncated input, nesting-depth
  bomb, trailing garbage, non-dict root.
- `feed.test.ts` — Torznab fixtures carrying `seeders`, `peers`, `magneturl`
  and an `application/x-bittorrent` enclosure; plus the malformed-XML and
  missing-required-field warning cases carried across from
  `newznab/client.test.ts`.
- `url-policy.test.ts` — carried across unchanged.

`fetch.test.ts` covers the redirect matrix: `200` with bytes, `302` to a
magnet, `302` same-origin, `302` to a foreign origin rejected, a redirect
echoing the API key rejected, and an over-cap body rejected.

`release-search/service.test.ts` — discovery failure surfaces 502; one indexer
failing leaves the others' results intact; category intersection including the
thousand-block rule and the empty-intersection fallback; dedupe tie-break
ordering by seeders then priority then date; `protocol` persisted on the
candidate; seeders absent from `rankRelease` inputs.

`downloads/service.test.ts` — torrent submit for both the bytes and magnet
paths; `ambiguous` add landing as `Unknown`; replay idempotence for both new
sources; an explicit legacy-fingerprint test that seeds a pre-refactor
`newznab` attempt and asserts a replay still matches; file-priority application
across two reconcile ticks; file-priority application resuming after a
simulated restart; a terminal attempt refusing a `files_applied_at` write.

`downloads/repository.test.ts` — migration `0006` row preservation: seed
`download_attempts` with rows of all three legacy source values, run the
migration, assert row-for-row equality on preserved columns.

Component tests — the download dialog showing seeders and a protocol badge, the
magnet whole-torrent notice, and the disabled state when a client is not
configured. The settings screen rendering the read-only discovered indexer list
after a test.

E2E — `tests/provider-server/` gains a Prowlarr stub serving
`/api/v1/indexer`, a per-indexer newznab feed, and a download proxy that
returns a `.torrent` on one path and a magnet redirect on another, reached via
a `GAMARR_PROWLARR_BASE_URL` override mirroring the existing
`GAMARR_IGDB_BASE_URL` pattern. The Internet Archive e2e fixtures and specs are
deleted. `@axe-core/playwright` assertions are retained.

## Acceptance criteria

1. Configuring one Prowlarr base URL and API key makes every enabled Prowlarr
   indexer searchable, with no per-indexer configuration in Gamarr.
2. A search returns results from torrent and usenet indexers in one ranked
   list, each source labelled with its protocol and, for torrents, its seeder
   count.
3. Submitting a torrent release adds it to qBittorrent, from `.torrent` bytes
   or from a magnet, and the attempt progresses through the normal lifecycle
   into Library and Activity.
4. Selecting a subset of a torrent's files results in only those files
   downloading, and the selection is reapplied correctly if Gamarr restarts
   between add and application.
5. Submitting a usenet release still reaches SABnzbd and behaves as before.
6. One failing indexer produces a warning and does not fail the search;
   Prowlarr being unreachable produces a 502.
7. After migration `0006`, every pre-existing download attempt is still present
   and still renders in Library and Activity.
8. The Prowlarr API key never appears in an API response, a warning, an error
   message, or a URL that Gamarr constructs.
9. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` all pass.

## Environment variables

Removed: `GAMARR_IA_BASE_URL`, `GAMARR_IA_MAX_BYTES`,
`GAMARR_IA_METADATA_MAX_BYTES`, `GAMARR_IA_TORRENT_MAX_BYTES`,
`GAMARR_DOWNLOAD_DIRECTORY`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAMARR_PROWLARR_MAX_TORRENT_BYTES` | `8388608` (8 MiB) | Ceiling for a `.torrent` metainfo fetch |
| `GAMARR_PROWLARR_BASE_URL` | none | Test-only override of the Prowlarr origin, mirroring `GAMARR_IGDB_BASE_URL` |

## Deployment note

`GAMARR_DOWNLOAD_DIRECTORY` disappearing means Gamarr no longer needs a
writable downloads volume. `/config` remains the only writable mount, holding
the database. Payloads land wherever SABnzbd and qBittorrent put them, which is
already true for everything except the retired direct-download path.

## References

- `docs/superpowers/specs/2026-07-31-gamarr-v1-design.md` — download lifecycle,
  candidate policy, trust model.
- `docs/superpowers/specs/2026-08-04-internet-archive-torrent-source-design.md`
  — the durable-claim torrent pattern this generalises, and the marker reuse it
  introduced.
