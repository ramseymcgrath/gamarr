# Internet Archive Torrent Source Design

## Summary

Adds a second delivery method for Internet Archive releases: instead of
streaming one file of an item to disk, Gamarr can hand the item's
`{identifier}_archive.torrent` to a qBittorrent instance and track it to
completion. The search side is unchanged — an Internet Archive result is still
one item from `advancedsearch.php` — and the choice between "one file" and
"whole item" is made in the download dialog.

This is deliberately the SABnzbd-shaped path, not the Internet Archive direct
path: claim the attempt, fetch bounded bytes, submit to an external client,
reconcile against a durable marker. Gamarr never moves the payload and never
becomes a BitTorrent peer.

## Goals

- Let the operator send a whole Internet Archive item to qBittorrent from the
  existing download dialog.
- Track those downloads through the normal lifecycle so they appear in Library
  and Activity like any other attempt.
- Keep the choice manual, per the v1 non-goals: no automatic selection between
  file and torrent, no monitoring, no scheduler.

## Non-goals

- Magnet links. Internet Archive publishes a real `.torrent` per item, and
  fetching bytes we already know how to bound is simpler than resolving
  metadata from a DHT.
- Torznab or any other torrent *search* source. This adds a delivery method to
  an existing source, not a new source.
- Save-path override, seeding or ratio policy, torrent removal, per-file
  selection within a torrent.
- A second torrent client. The port makes Transmission additive later; shipping
  two adapters now roughly doubles the surface for no v1 benefit.

## Upstream facts this design depends on

- Every derived Internet Archive item carries `{identifier}_archive.torrent` in
  its `/metadata/` manifest with `source: "metadata"` and
  `format: "Archive BitTorrent"`. Items that have not been derived do not have
  one, so availability must be detected, never assumed.
- The torrent covers the **entire item**, not a file. Its size is the item
  size, which the search document already reports as `item_size`.
- `POST /api/v2/auth/login` takes form-encoded `username`/`password` and
  returns a `SID` cookie. qBittorrent rejects requests whose `Referer` does not
  match its own host unless the operator disabled that check, so the adapter
  always sends one.
- `POST /api/v2/torrents/add` is `multipart/form-data` with a `torrents` part
  carrying the raw bytes, plus optional `category` and `tags`. WebAPI 2.14.0
  and later respond with JSON `{ added_torrent_ids, success_count,
  pending_count, failure_count }`; earlier builds respond with the literal
  text `Ok.`. It returns 415 for an invalid torrent file and 409 when every
  torrent in the request failed to add.
- `GET /api/v2/torrents/info?tag=...` returns objects carrying `hash`, `state`,
  `progress` (0..1), `name`, and `size`.

Because the hash is not available from every qBittorrent version, identity on
our side is the **tag**, and the hash is an optimisation recorded when offered.

## Data model

### Migration `0004`

Generated with `pnpm db:generate`; never hand-edited after commit.

**New table `qbittorrent_settings`**, mirroring `sabnzbd_settings`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer PK | `check(id = 1)` singleton |
| `base_url` | text not null | |
| `username` | text not null | |
| `password` | text not null | Secret. Never serialized to a response. |
| `default_category` | text | Passed to `torrents/add` when set |
| `last_test_status` | text | |
| `last_tested_at` | integer | |
| `config_revision` | integer not null default 1 | |
| `updated_at` | integer not null | |

**`download_attempts` gains one column:** `torrent_hash text` (nullable).

Deliberately **no unique index**. The `(sabnzbd_config_revision, sab_job_id)`
index exists because a SABnzbd job id is unique within a SABnzbd instance; a
torrent infohash is a property of the *content*, and the same Internet Archive
item may legitimately be fetched for two different library entries. A unique
index would reject the second as a duplicate.

Both changes are additive `ALTER TABLE` statements. `download_attempts.source`
carries no CHECK constraint — it was added by plain `ALTER TABLE ADD COLUMN` in
migration `0003` — so admitting a third value requires no table rebuild.

### Source values

`download_attempts.source` gains `internet-archive-torrent`. This is an
*attempt* source, not a *release* source:

- `Release.source` and `release_candidates.source` stay
  `newznab | internet-archive`. The CHECK constraint on `release_candidates` is
  untouched, and search results are unchanged.
- `DownloadAttempt.source` widens to
  `ReleaseSourceType | "internet-archive-torrent"` via a new exported
  `AttemptSourceType`.

Keying on source rather than on a separate delivery column is what lets
`assertSameRequest` keep working: it recomputes a replayed submission's
fingerprint from the stored attempt's own source, because the candidate that
produced it may already have expired.

### Marker reuse

`sab_marker` becomes the qBittorrent tag, holding the same
`gamarr-{attemptId}` value it already holds. That column is already the generic
attempt marker in practice — the Internet Archive direct path writes it even
though SABnzbd never sees it — and it already carries the unique index that
makes a tag safe to match on. A parallel `torrent_tag` column would duplicate
both the value and the constraint.

## Ports and adapters

### `TorrentClientPort` (`src/features/downloads/port.ts`)

```ts
export type TorrentAddOutcome = "rejected" | "ambiguous";

export class TorrentAddError extends AppError {
  constructor(readonly outcome: TorrentAddOutcome, message: string, options?: ErrorOptions);
}

export interface TorrentJob {
  hash: string;
  tags: string[];
  state: string;
  progress: number; // 0..100, already scaled
}

export interface TorrentClientPort {
  add(input: {
    torrent: Uint8Array;
    filename: string;
    category: string | null;
    tag: string;
  }): Promise<{ hash: string | null }>;
  list(): Promise<TorrentJob[]>;
  testConnection(): Promise<void>;
}
```

`TorrentAddError` mirrors `SabnzbdUploadError` exactly, and for the same reason:
only a failure that provably added nothing may be persisted as terminal
`Failed`. 415 and 409 are `rejected`; a timeout, an aborted connection, a 5xx,
or an unparseable body is `ambiguous` and becomes `Unknown`.

`add` returns `{ hash: null }` on the older `Ok.` builds. That is not an error —
reconcile finds the torrent by tag.

### `src/integrations/qbittorrent/client.ts`

- Caches the `SID` cookie per instance; logs in lazily on first use and retries
  a request once after a fresh login if it comes back 403.
- Sends `Referer: {baseUrl}` on every call to satisfy qBittorrent's CSRF check.
- Bounds every JSON response with `read-bounded-response`.
- Throws only `AppError` subclasses. Upstream messages are never forwarded: a
  qBittorrent URL can carry credentials in `username:password@` form, and
  `failureDetail` is rendered in Activity.
- `list` issues **one** unfiltered `torrents/info` request per reconcile and
  matches tags client-side against the `tags` field each torrent carries.
  qBittorrent's `tag=` query parameter accepts a single value, so filtering
  server-side would mean one HTTP request per in-flight attempt. The response is
  bounded like every other, and a torrent may carry several tags, hence
  `tags: string[]` and a membership test rather than equality.

### `InternetArchiveClient.fetchTorrent(identifier, maxBytes)`

Fetches `/download/{identifier}/{identifier}_archive.torrent` and returns
bounded `Uint8Array` bytes via `read-bounded-response`. Never written to disk,
same rule as NZBs. Reuses the redirect policy already in
`InternetArchiveDownloader` — same-origin or `*.archive.org` over HTTPS, no
credentials, no fragment — extracted to a shared helper so the two call sites
cannot drift.

Ceiling: `GAMARR_IA_TORRENT_MAX_BYTES`, default 8 MiB. A torrent's size grows
with its piece count, so a very large item's metainfo is meaningfully bigger
than an NZB but nowhere near the metadata manifest ceiling.

## Request path

### `GET /api/releases/files`

Response gains two fields:

```ts
{
  files: SelectableFile[];
  torrent: { name: string; size: number | null } | null;
  torrentClientConfigured: boolean;
}
```

`torrent` is `null` when the item's manifest has no `_archive.torrent`.
`torrentClientConfigured` is false when `qbittorrent_settings` is absent or has
no password, which lets the dialog render the entry disabled with a reason
rather than silently omitting it — an operator who expected a torrent option
should learn *why* it is missing.

Detection lives in `release-search/file-selection.ts` as
`selectItemTorrent(files)`, next to `selectCandidateFiles`, so the module stays
the single owner of "what counts as a selectable payload". It matches on
`source === "metadata"` and a `_archive.torrent` suffix, and still runs the
name through `isSafeInternetArchiveFileName`.

### `POST /api/downloads`

`SubmitDownloadInput` gains:

```ts
delivery?: "file" | "torrent"; // default "file"
```

Defaulting to `"file"` keeps every existing client, test, and the e2e suite
working without change. The field is explicit on the wire even though the UI
presents one radio list, so `fileName` never has to carry a sentinel value.

Validation: `delivery: "torrent"` with a `fileName` is a validation error, not
a silently ignored field — unlike the Newznab case, where an ignored file name
is load-bearing for replay compatibility with rows already in deployed
databases.

## Download lifecycle

`DownloadService.submit` branches to `submitInternetArchiveTorrent` when the
candidate's source is `internet-archive` and `delivery` is `"torrent"`.

1. Validate the identifier with `isValidInternetArchiveIdentifier`.
2. Read `qbittorrent_settings`; absent or passwordless is a validation error
   ("qBittorrent is not configured").
3. Confirm the item still has a torrent, via the same metadata lookup the file
   path uses for `getFileInfo`. A stale candidate fails here rather than at the
   client.
4. Claim the attempt at `Pending` with `source: "internet-archive-torrent"`,
   `iaFileName: null`, `sabMarker: gamarr-{attemptId}`,
   `sabnzbdConfigRevision: 0` (the existing "unbound" marker), `size` from the
   candidate's item size.
5. Fetch the torrent bytes. Failure → `Failed` with the `AppError` message, or
   a generic message for anything that is not an `AppError`.
6. `Submitting`, stamping `sabRequestStartedAt`.
7. `add()`. Success → `Queued`, recording `torrent_hash` when the response
   offered one. `rejected` → `Failed`. `ambiguous` → `Unknown`.

Fingerprint identity by source:

| Source | Identity |
| --- | --- |
| `newznab` | `[candidateId, gameId, platformId]` |
| `internet-archive` | `[candidateId, gameId, platformId, fileName]` |
| `internet-archive-torrent` | `[candidateId, gameId, platformId]` |

Replaying one submission key against a different delivery therefore mismatches
and returns 409, which is correct: the two produce different downloads.

### Reconcile

`reconcile` today returns early when SABnzbd is unconfigured. It becomes two
independent branches, each guarded by its own settings, so a torrent-only
operator gets reconciliation without configuring SABnzbd at all. A failure in
one branch must not suppress the other.

Torrent attempts are matched by `torrent_hash` when present, otherwise by tag.
State mapping:

| qBittorrent state | Status |
| --- | --- |
| `uploading`, `stalledUP`, `pausedUP`, `queuedUP`, `forcedUP`, `checkingUP` | `Completed` |
| `error`, `missingFiles` | `Failed` |
| `downloading`, `stalledDL`, `metaDL`, `forcedDL`, `checkingDL`, `allocating` | `Downloading` |
| `queuedDL`, `pausedDL`, `checkingResumeData`, `moving` | `Queued` |

Anything unrecognised maps to `null` — no verdict yet — exactly as SABnzbd
post-processing states do. Writing a terminal status on an unknown state would
be permanent, since reconcile never revisits a `Completed` or `Failed` attempt.

`progress` is `Math.round(job.progress * 100)`, clamped to 0..100 to satisfy the
existing CHECK constraint. Completion writes 100 regardless.

### Recovery

`recoverStaleInternetArchiveDownloads` filters on
`eq(source, "internet-archive")`, so a torrent attempt is excluded by
construction — correctly, because qBittorrent keeps downloading across a Gamarr
restart and the attempt is not orphaned. This is asserted by a test rather than
left to the reader, since the two source strings share a prefix and a future
`like`-based filter would silently break it.

### Known limitation: the same item submitted twice

A torrent's infohash is a property of its content, so two attempts against the
same Internet Archive item resolve to one torrent inside qBittorrent — it
deduplicates on infohash and will not create a second entry. That is why
`torrent_hash` carries no unique index, but it also means the second submission
cannot be made to behave like a fresh download:

- On a build that returns `added_torrent_ids`, a duplicate add reports a
  failure, which is `ambiguous` rather than `rejected` — nothing is provably
  wrong with the request, and the torrent may well be downloading. The attempt
  becomes `Unknown`.
- Reconcile then resolves it if qBittorrent applied the second tag to the
  existing torrent, and leaves it `Unknown` if it did not.

`Unknown` is the correct outcome here and needs no special casing: it already
means "the outcome is not established", is never resubmitted automatically, and
is visible in Activity for the operator to resolve. Deduplicating submissions by
infohash ahead of the add would require parsing bencode to compute the hash
locally, which buys a better message for a rare case at the cost of a parser on
the untrusted-input path. Out of scope.

## Settings

- `GET /api/settings` includes a `PublicQbittorrentSettings` shape:
  `{ baseUrl, username, hasPassword, defaultCategory, lastTestStatus,
  lastTestedAt }`. The password never appears.
- `PUT /api/settings/qbittorrent` accepts the same `secretUpdateSchema`
  retain/clear/replace discriminated union the other secrets use.
- `POST /api/settings/qbittorrent/test` calls `testConnection()` and records
  `lastTestStatus` / `lastTestedAt`, mirroring the SABnzbd route pair.

All three are mutating or state-recording and go through
`assertTrustedMutation`.

## User experience

The dialog keeps one radio group. When the item has a torrent, it is pinned
above a separator as the first entry:

```
Select what to download
(o) Entire item (torrent)  · 1.4 GB · via qBittorrent
----------------------------------------------------
( ) doom2.zip              ZIP · 12 MB
( ) doom2_manual.pdf       PDF · 4 MB
```

- The submit button reads "Send to qBittorrent" when the torrent entry is
  selected and "Download file" otherwise.
- Selection default stays the largest file, not the torrent. Direct download is
  the established behaviour and the cheaper action; making the torrent the
  default would change what an existing operator gets from an unchanged
  gesture.
- When `torrentClientConfigured` is false the entry renders disabled with
  "qBittorrent is not configured" as its meta text.
- The separator is a `<hr>` inside the fieldset, not a colour change, and the
  torrent entry's distinguishing information is in its label text. Nothing here
  encodes meaning in colour alone (WCAG 2.2 AA).
- Activity and Library label the source "Internet Archive (torrent)".
- The result state reads "Added to qBittorrent" / "The job is saved in your
  Gamarr library and queued in qBittorrent."

## Failure handling and security

- The qBittorrent password is a secret on the same footing as an indexer API
  key: never in a response, never in an error message, never in a React Query
  key.
- `failureDetail` is only ever written from an `AppError` message. Anything else
  becomes a fixed generic string, because a raw client or `undici` error can
  carry the request URL, and a qBittorrent base URL may embed credentials.
- The `.torrent` fetch is size-bounded and redirect-restricted on the same terms
  as the file download.
- A qBittorrent instance is reachable on the LAN by definition; the trust
  boundary is unchanged.

## Testing

**Unit**
- `qbittorrent/client.test.ts`: login and cookie reuse, `Referer` presence,
  re-login once on 403, `add` parsing for both the JSON and `Ok.` responses,
  415 → `rejected`, 409 → `rejected`, timeout and 5xx → `ambiguous`,
  `listByTags` parsing and progress scaling, no upstream message forwarded.
- `file-selection.test.ts`: torrent detected, absent when underived, rejected
  when the name fails the path policy, and never present in `files`.
- `downloads/service.test.ts`: torrent submit happy path records
  `torrent_hash`; replay returns the same attempt; replay with a different
  delivery 409s; unconfigured client is a validation error; missing torrent is a
  validation error; `rejected` → `Failed`; `ambiguous` → `Unknown`; reconcile
  state mapping including the unrecognised-state case; reconcile works with
  SABnzbd unconfigured; recovery leaves torrent attempts alone.
- `downloads/repository.test.ts`: `torrent_hash` round-trips; a terminal attempt
  refuses a later torrent write.
- `internet-archive/client.test.ts`: `fetchTorrent` bounds, redirect policy,
  bytes never touch disk.

**Component**
- `download-dialog.test.tsx`: torrent entry pinned first; submit label switches;
  disabled with a reason when the client is unconfigured; entry absent when the
  item has no torrent; the file list still submits `delivery: "file"`.

**Handler**
- `releases/handlers.test.ts` for the new response fields;
  `settings/handlers.test.ts` for the qBittorrent shape and secret redaction.

**End-to-end**
- Extend `tests/provider-server/` to serve `_archive.torrent` bytes and to stand
  in for qBittorrent (`auth/login`, `torrents/add`, `torrents/info`).
- New spec: configure qBittorrent, search, pick the torrent entry, submit, see
  the attempt reach `Queued` and then `Completed` after a reconcile, with an
  axe pass on the dialog.

## Acceptance criteria

1. An Internet Archive item with a torrent offers it as the first entry in the
   download dialog; one without does not.
2. Submitting it creates an attempt with source `internet-archive-torrent` and
   no `iaFileName`, and the item appears in qBittorrent tagged
   `gamarr-{attemptId}`.
3. The attempt reaches `Completed` through reconcile on both a WebAPI build that
   returns hashes and one that returns `Ok.`.
4. An invalid torrent yields `Failed`; a lost acknowledgement yields `Unknown`
   and is never resubmitted automatically.
5. Replaying a submission key with a different delivery returns 409.
6. A restart does not fail an in-flight torrent attempt.
7. Reconcile works with SABnzbd entirely unconfigured.
8. No response, log line, or `failureDetail` contains the qBittorrent password
   or a credentialed URL.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAMARR_IA_TORRENT_MAX_BYTES` | `8388608` (8 MiB) | Ceiling for an item's `.torrent` metainfo |

No other new variables. qBittorrent connection details are operator settings in
SQLite, not environment, matching SABnzbd and the indexers.

## References

- `docs/superpowers/specs/2026-07-31-gamarr-v1-design.md` — authoritative for the
  download lifecycle, data model, and security requirements this extends.
- qBittorrent WebUI API v2:
  <https://github.com/qbittorrent/qbittorrent/wiki/WebUI-API-(qBittorrent-5.0)>
- qBittorrent `WebAPI_Changelog.md`, entry 2.14.0 — `torrents/add` response
  shape change.
