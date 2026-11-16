# Collection Torrents Design

## Summary

Lets gamarr use a large multi-file "collection" torrent, with one archive per
game, as a search source. The operator drops the `.torrent` into a folder.
Each search then lists that collection's matching files as individual
releases. Grabbing one sends the collection to qBittorrent with **only that
file** enabled, and every later grab from the same collection turns on one
more file in the torrent that is already loaded.

The first collection is `My Sony PlayStation 2 (USA) Collection.torrent`:

- 2,065 files, 2.9 TB, one Redump-named `.7z` per USA PS2 game (e.g.
  `007 - Nightfire (USA).7z`), no subfolders.
- Info-hash `8517b29d393c291aa331e9f479b3767321b200ed`, 13 seeders on
  opentrackr as of 2026-11-16.
- Every tracker listed in the file is dead. qBittorrent already appends 20
  working trackers to every new torrent (`Session\AddTrackersEnabled`) and DHT
  is on, so gamarr does nothing about trackers.

## Why

No indexer gamarr searches carries this torrent, so its games never show up.
Even when a collection does come through an indexer, the existing file picker
shows thousands of unsorted checkboxes. Its selection is also applied only
after the torrent has started, so qBittorrent begins pulling pieces of games
nobody picked.

Collections are the best source for clean Redump USA discs. On 2026-11-15
gamarr could only find a PAL Nightfire, while this collection has the USA
disc.

## Goals

- Collection files show up in release search next to Internet Archive and
  Prowlarr results, one release per matching file, ranked by the existing
  matcher.
- Grabbing a collection release downloads only that file, and no other file
  ever downloads, not even for a moment.
- Further grabs from the same collection reuse the loaded torrent.
- Each attempt's progress, completion, Redump verification and PS2 library
  export apply to its own file, not the whole torrent.

## Non-goals

- An upload or management UI. Collections are files in a folder.
- Automatic grabbing, monitoring, or a scheduler (gamarr v1 non-goals).
- Removing a game from a collection torrent, deselecting files, or deleting
  data when an attempt is deleted.
- Magnet-only collections. Gamarr needs the metainfo to list files.
- Seeding or ratio policy, and tracker management.
- Collections for other download clients. qBittorrent is the only torrent
  client.

## Anti-goals (a failure even if everything else works)

- **Downloading the whole collection.** A stray start before the priorities
  are set could pull terabytes. Any failure between "added" and "priorities
  applied" must leave the torrent stopped.
- **Changing another attempt's files.** Today's reconcile sets every
  unselected file to priority 0. For a collection that would switch off other
  games already being downloaded.
- **Verifying or exporting the wrong game.** The torrent's `content_path` is
  the collection folder, which holds every game grabbed so far.

## Constraints from the codebase

- **Code layout:** features reach the outside only through ports, and
  `dependencies.ts` binds the adapters (CLAUDE.md "Feature slices").
  `prowlarr/metainfo` is already an allowed pure-decoding import for the
  release-search and downloads services.
- **Writes:** the container's root filesystem is read-only. `/config` is the
  only writable volume, and gamarr only *reads* collection files.
- **Idempotent submit:** the request fingerprint is chosen by attempt source.
  The repository's `update` refuses writes to terminal attempts.
- **better-sqlite3:** it's synchronous, so there must be no `await` inside a
  transaction. Claim first, then do network I/O (see
  `DownloadService.submit`).
- **Accessibility:** WCAG 2.2 AA. A collection result needs a text label for
  its source, not just an icon.
- **Size limit:** `GAMARR_PROWLARR_MAX_TORRENT_BYTES` (8 MiB) bounds fetched
  metainfo. This collection's `.torrent` is 3.6 MiB.

## Approaches considered

1. **A folder source (chosen).** `.torrent` files in a collections folder are
   read and indexed by gamarr, and each collection becomes a pseudo-indexer
   like Internet Archive. It needs no new UI, and adding a collection is a
   single `scp`. Collections will be added rarely.
2. **An upload page in Settings.** Same search and download behavior, plus a
   page to add and remove collections. It's friendlier, but adds a route,
   upload validation, storage of the metainfo in SQLite or `/config`, and
   tests. The operator chose the folder.
3. **Better file picking for indexer torrents only** (pre-select the matching
   file inside any big torrent from Prowlarr or Internet Archive). This
   doesn't help, because the collection isn't on any indexer. It could be a
   later step that reuses this matching.

## Design

### Loading collections

- New env var `GAMARR_COLLECTIONS_DIR`, defaulting to `<database dir>/collections`
  (`/config/collections` in the container). If the folder is missing, there
  are no collections and no warning is shown.
- **Platform comes from the subfolder** (*my call*). A collection lives in
  `collections/<igdb platform id>/` (e.g. `collections/8/` for PS2), and only
  searches for that platform look at it. Redump file names carry no platform
  token, so without this a Wii or PS3 search for a shared title would return
  PS2 files. A `.torrent` at the top level is ignored, with a warning that
  names it.
- A `CollectionsPort` (`src/features/release-search/ports.ts`) has
  `list(): Collection[]`. Each `Collection` is
  `{ id: infoHash, platformId, name, torrentFileName, files: { index, name, size }[] }`.
- The adapter `src/integrations/collections/folder.ts`:
  - reads `<platformId>/*.torrent`, ignoring symlinks and deeper folders;
  - rejects any file over `GAMARR_PROWLARR_MAX_TORRENT_BYTES`;
  - decodes it with `decodeTorrentFiles`;
  - computes the v1 info-hash (SHA-1 of the bencoded `info` dict), which is a
    new pure helper in `prowlarr/metainfo`;
  - caches each file's result by `(path, mtime, size)`.

  A file that fails to decode becomes a search warning naming the file, and
  the other collections still work.
- Two files with the same info-hash are kept once, as the first in name
  order.

### Search

- Each collection is a pseudo-indexer: id `collection:<infoHash>`, name =
  torrent `info.name`, protocol `torrent`, priority 0.
- Collections are ranked with `PREFERRED_SOURCE_BONUS`, like Internet Archive
  (builder's call to confirm this ranks sensibly next to IA).
- **Picking files:** for each collection, take the file's base name without
  its extension and compute its `titleKey`. A file becomes a release when that
  key equals the `titleKey` of:
  - the game's title or one of its IGDB alternative names, or
  - one of the Redump game names found by the serial lookup that already runs
    for PS1/PS2.

  Multi-disc sets (`(Disc 1)`, `(Disc 2)`) and revisions produce several
  releases. That's fine, because the matcher ranks them. Cap the results at 25
  files per collection.
- Matching is a scan of the in-memory list, about 2k names, with no I/O per
  search. If the Redump lookup gives up after its 5 s limit, title keys alone
  still work.
- **Release fields:** `guid` = `collection:<infoHash>:<index>`, `title` = the
  file's base name, `size` = the file's size, `seeders` = null,
  `publishedAt` = null, `downloadUrl` = `collection:<infoHash>/<index>` (not
  fetched).
- **The saved candidate:** `indexerId` is the pseudo-indexer id, and
  `sourceSnapshot` is `{ indexerName, collectionId, torrentFileName,
  fileIndex, fileName }`. The download step re-reads the `.torrent` by
  `collectionId` and refuses it if the file at `fileIndex` no longer has
  `fileName`.
- **Routing** (*my call*): this follows the Internet Archive precedent.
  Collection candidates skip `url-policy` because gamarr built them itself
  and no feed URL is involved. Fetch routing branches on the `collection:`
  indexer-id prefix and loads bytes through `CollectionsPort`, never through
  an HTTP fetch. `GET /api/releases/files` returns the single file for a
  collection candidate, so the dialog needs no special case for loading.
- **UI:** the source column shows the collection name (text). The download
  dialog shows "Gamarr will turn on `<file name>` in `<collection>`" and no
  file picker.

### Grabbing

- **New attempt source:** `collection-torrent`. Its fingerprint is
  `[candidateId, gameId, platformId, "torrent", fileIndex]`. `selectedFiles`
  is always `[{ index: fileIndex, name }]` from the candidate, and any
  `selectedFiles` in the request is rejected with a validation error. Add the
  value to `AttemptSourceType`, plus a migration if the column has a CHECK or
  enum (builder: check the schema).
- **Submit:** claim the attempt the same way as today. Then, outside any
  transaction:
  1. Ask qBittorrent whether it already has `infoHash`
     (`torrents/info?hashes=`).
  2. **Not loaded:** add the `.torrent` bytes with `stopped=true` (the
     deployed client is qBittorrent 5.3.0, linuxserver
     `5.3.0_v2.1.2-ls486`; 4.x support isn't needed), plus the attempt's
     marker tag and category. Right after adding, set **every** file to
     priority 0 in one call, before anything else. The torrent is v1-only (no
     `file tree`), so qBittorrent's hash equals the computed info-hash, and
     `torrentHash` is stored at claim time.
  3. **Already loaded, or the add returns 409:** add the attempt's marker to
     the existing torrent with `torrents/addTags` (tags are per torrent, so a
     shared torrent carries one marker per attempt).
  4. Read `torrents/files`. Check that the file name at `fileIndex` matches,
     and refuse if it doesn't.
  5. Set `fileIndex` to priority 1. Never lower any file's priority on a
     torrent that was already loaded.
  6. **Safety check before starting** (*my call*). Read the priorities again.
     Every file with priority above 0 must belong to an attempt that is
     `collection-torrent`, not terminal, and on this info-hash. If any other
     file is wanted, don't start. Fail the attempt with "Other files in this
     collection are enabled in qBittorrent; set them to Do not download, then
     retry". This covers a torrent the operator loaded by hand and a fresh add
     that died before step 2's zero-everything call. When the check passes,
     `torrents/start`. A grab also restarts a torrent the operator had
     stopped, because grabbing means "download this".
  7. Stamp `filesAppliedAt`. The attempt is now `Downloading`.

  If any step from 2 to 6 fails, the attempt becomes `Failed` with a text
  detail. A torrent added in step 2 stays stopped. Gamarr never deletes it,
  so the operator can see it in qBittorrent.
  Stale-submission recovery (*my call*) fails a `collection-torrent` attempt
  stuck in `Submitting` and doesn't re-run it. The torrent stays stopped, the
  operator retries the grab, and step 6 makes that safe. A fingerprint
  replay returns the existing attempt unchanged, as other sources do.
- **Concurrency:** two grabs from one collection at the same time are the
  "already loaded / 409" path for the second one. Step 5 only ever raises a
  priority on an existing torrent, so the order doesn't matter.

### Progress and completion

- For a `collection-torrent` attempt, reconcile skips today's "set
  unselected files to 0" block.
- The attempt is matched to its torrent by `torrentHash`, not by tag, because
  several attempts share one torrent.
- Progress comes from the attempt's own file: `torrents/files` `progress` ×
  100. `listFiles` grows a `progress` field.
- How collection attempts map from qBittorrent (*my call*):

  | qBittorrent | attempt |
  |---|---|
  | the file's progress = 1 and the torrent isn't errored (seeding and `stoppedUP` count) | `Completed` |
  | torrent `error` or `missingFiles` | `Failed`, detail = state, for every attempt on that hash |
  | `stoppedDL` with the file's progress < 1 | `Downloading`, progress kept, detail "Stopped in qBittorrent" |
  | anything else with the file's progress < 1 | `Downloading` |
  | the hash is no longer in qBittorrent | `Failed`, "Torrent was removed from qBittorrent" |

  Since the hash is known from claim time, removal is detectable, unlike
  today's tag-matched attempts. Today's update clears `failureDetail` on
  non-failures, so the "Stopped" text needs a field that survives (builder's
  call: a new `statusDetail`, or let collections keep `failureDetail`), and it
  must show as text in Activity. The torrent-level `progress` is never used.

### Verification and PS2 export

- For `collection-torrent` attempts, the existing locator
  (`verification/service.ts` `locate`) gets a new branch. It returns
  `<save_path>/<file name>`, using qBittorrent's `save_path` plus the file's
  path, which already includes the torrent's root folder. It does not return
  `content_path`. `TorrentJob` gains `savePath`.
- The existing `GAMARR_DOWNLOAD_PATH_MAP` mapping and the "nothing escapes
  the root, no symlinks" rules apply unchanged.
- Verification and export then see exactly one `.7z`. The existing
  `SevenZipArchives` path streams the `.iso` out, verifies it against Redump,
  and exports it to `/ps2/DVD`.
- `NodeDiscFiles.list` already accepts a single file path (`lstat` →
  `isFile`), so no scanner change is needed.

## Testing

- **Folder adapter:**
  - decodes a real-shaped two-file fixture and computes its info-hash;
  - skips symlinks, oversize files, malformed files and top-level `.torrent`s
    (each with a warning);
  - reads the platform from the subfolder name;
  - uses the mtime cache.
- **Search service:**
  - a game matches its file by title, by alternative name and by Redump name;
  - a non-matching game yields nothing;
  - the 25-file cap holds;
  - a broken collection only adds a warning;
  - a collection in another platform's folder is never searched.
- **Download service, with a fake qBittorrent port:**
  - fresh add → stopped, every other file at 0, the target at 1, then
    started;
  - already loaded → tag added, only the target raised, no file lowered, no
    second add;
  - a 409 on add → takes the already-loaded path;
  - a file-name mismatch → Failed, nothing started;
  - a failure after add → the torrent is never started;
  - a loaded torrent with an unowned file above priority 0 → Failed with the
    "Other files…" detail, never started;
  - a stale `Submitting` collection attempt → Failed, no qBittorrent calls;
  - fingerprint replay;
  - `selectedFiles` in the request → rejected.
- **Reconcile:**
  - two attempts on one torrent get independent per-file progress and
    completion;
  - the unselected-to-0 block never runs for collections;
  - each row of the state table, including a removed hash → Failed.
- **Locator:** returns the file path, not `content_path`.
- **E2E (stub provider server):** one collection fixture in a temporary
  collections folder, search → grab → stub qBittorrent receives
  `stopped=true` and the priority calls in order.

## Rollout

- The image needs no change, since 7-Zip is already installed. Mount nothing
  new: `/config/collections` is inside the existing `/config` volume.
- `scp` the `.torrent` to the server's gamarr config folder under
  `collections/8/` (8 = PS2). A restart isn't needed.
- Document `GAMARR_COLLECTIONS_DIR` in CLAUDE.md's env table and add a
  paragraph next to the Internet Archive one.

## Left to the builder

- How the collection label renders in `release-results.tsx`.
- Whether `PREFERRED_SOURCE_BONUS` needs a collection-specific tweak.
- How to order the five or so new qBittorrent client methods
  (`info?hashes`, `addTags`, `start`/`resume`, file `progress`) and how to
  fake them in tests.
