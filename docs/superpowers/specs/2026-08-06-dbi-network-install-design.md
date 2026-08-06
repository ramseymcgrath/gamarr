# DBI Network Install Design

## Summary

Serve completed Switch game files over HTTP as an Apache-style directory index, so a
Nintendo Switch running [DBI](https://github.com/rashevskyv/dbi) can install them over
the LAN via its `ApacheHTTP` network source.

This exists to work around a hard filesystem limit, not to add a download path. A Switch
SD card is normally FAT32, which caps a single file at 4 GiB. Switch dumps routinely
exceed that — a representative pair on the author's server is 14.9 GiB and 7.4 GiB — so
copying them onto the card fails partway through regardless of free space. The
alternatives are splitting each file into a part-directory and fixing the archive bit on
the console, or reformatting to exFAT, whose Switch driver is known to corrupt cards.
Installing over the network sidesteps all of it: DBI splits NCAs internally as it writes,
so the 4 GiB ceiling never applies.

## Product goals

- Expose operator-nominated directories of Switch-installable files as a directory index
  DBI can browse.
- Name entries after the real game title where gamarr knows it, rather than the
  attempt-derived directory name written to disk.
- Support resumable transfers, because a 14.9 GiB install over Wi-Fi will drop.

## Non-goals

- No install orchestration. gamarr does not talk to the Switch; DBI pulls.
- No transcoding, splitting, decompression, or NSP/XCI conversion.
- No write path. Every route is `GET`; nothing here mutates state.
- No new acquisition source. This serves files that already exist on disk.
- No pairing, discovery, or mDNS. The operator types a URL into `dbi.config` once.

## Deployment and trust model

The feature is off by default and has no implicit roots.

> `GAMARR_SWITCH_LIBRARY_DIR` — comma-separated absolute paths to serve. Unset or empty
> means both routes return `404` and nothing is scanned.

An earlier draft made a single library path also implicitly expose
`GAMARR_DOWNLOAD_DIRECTORY`. That was rejected: setting a *library* path should not
silently expose a *different* directory. The operator names every root explicitly.

Both routes are unauthenticated `GET`, consistent with the existing Library and Activity
read routes. `assertTrustedMutation` guards non-`GET` only and does not apply. This is a
deliberate acceptance of the existing trust boundary — the LAN — and it is why the
enabling variable must be set by hand: anything on the LAN that can reach the port can
enumerate and download every file under the configured roots. DBI is not a browser, sends
no `Origin`, and cannot attach a bearer token, so origin- or header-based protection
would break the only client this feature has.

gamarr's container mounts only `/app/gamarr/config` → `/config`. Torrent-acquired files
live under qBittorrent's save path and are invisible to gamarr without a second mount.
Serving them requires adding one, read-only:

```yaml
volumes:
  - gamarr-config:/config
  - /data/data/downloads:/library:ro
```

with `GAMARR_SWITCH_LIBRARY_DIR=/library`, or `/library,/config/downloads` to include
Internet Archive direct downloads in the same list.

## Architecture

### Modules

```
src/features/switch-library/
  models.ts        SwitchLibraryEntry { slug, displayName, absolutePath, sizeBytes, sourceRoot }
  ports.ts         SwitchLibraryScanner, SwitchLibraryTitleReader
  repository.ts    SqliteSwitchLibraryRepository — sab_marker -> game title
  service.ts       SwitchLibraryService.index() / .resolve(slug)
  slug-policy.ts   pure: extension filter, exclusions, slug + collision suffixing

src/integrations/filesystem/switch-library-scanner.ts

src/app/api/dbi/
  route.ts           GET  -> HTML autoindex
  [slug]/route.ts    GET  -> streams one file
  dependencies.ts
  handlers.ts
  handlers.test.ts
```

`slug-policy.ts` performs no I/O, so `service.ts` may import it directly — the same
exemption already granted to `newznab/url-policy` and `internet-archive/path-policy`.
Filesystem work in `src/integrations/` follows the precedent set by
`internet-archive/downloader.ts`.

Routes set `runtime = "nodejs"` and `dynamic = "force-dynamic"`.

### Index freshness

Both routes rescan on every request. There is no cache.

A cached index was considered, reusing the `RefreshCoordinator` landed for
`platform_popular_games`. It was rejected because a cached entry can outlive the file it
names, so the download route would need a revalidate-on-open step anyway — which is most
of the scan cost back, plus an invalidation story, for a directory holding tens of files.
Rescanning is self-healing: a deleted file simply stops appearing. Revisit only if these
roots grow large enough that walking them is measurable against a multi-minute install.

## Data flow

Index request:

1. Scan each configured root to a maximum depth of two, collecting regular files. Depth
   one is a file sitting directly in the root; depth two is a file one directory down,
   which is where both real layouts put them — `{identifier}/{fileName}` for Internet
   Archive downloads and `gamarr-{attemptId}/{fileName}` for torrent saves. Directories
   below depth two are not descended into.
2. Drop dotfiles, `.gamarr-*.part`, and any extension outside `.nsp` / `.nsz` / `.xci` /
   `.xcz`.
3. `realpath` each survivor and discard any that no longer resolves under its own root,
   rejecting symlink escapes out of a read-only mount.
4. Take each file's parent directory name. Where it matches `gamarr-{uuid}`, resolve it
   against `download_attempts.sab_marker` in one batched indexed query, joining through
   `library_entries` to `games.title`.
5. Display name is `{game title}{ext}` when resolution succeeds, otherwise the on-disk
   filename verbatim.
6. Resolve collisions, then sort. Group entries sharing a display name, order each group
   by absolute path, and leave the first unsuffixed while the rest take ` (2)`, ` (3)`,
   and so on before the extension. Ordering by absolute path — not by scan order, which
   `readdir` does not guarantee — is what keeps a given file's number stable across
   scans. Sort the finished list by display name last, so numbering never depends on it.
7. Emit minimal HTML: `<a href="{percent-encoded slug}">{display name}</a>` per entry.
   Relative hrefs resolve against `/api/dbi/`, so DBI reaches `/api/dbi/{slug}` and
   derives its install filename from that basename.

File request: rerun the same scan, look the slug up in the resulting map, `404` when
absent.

**The slug is never joined onto a path.** It is only ever a map key, and a filesystem path
is used only if the scan itself produced it. There is consequently no traversal surface
to validate against.

`sab_marker` carries a `UNIQUE` index, and it is written as `gamarr-{attemptId}` for
every attempt regardless of source, so the directory-name lookup is exact rather than
heuristic.

### Reading a file

Open the file first, then `fstat` the descriptor and stream from it — not stat-then-open.
gamarr may be writing into these directories concurrently, and opening first closes the
window in which a file changes between the size check and the read.

## Range requests

Mandatory, not optional. The largest file in the motivating case is 14.9 GiB; without
range support a dropped Wi-Fi transfer restarts from zero.

| Case | Status | Headers |
| --- | --- | --- |
| Whole file | `200` | `Content-Length`, `Accept-Ranges: bytes` |
| `bytes={s}-{e}` | `206` | `Content-Range: bytes {s}-{e}/{total}`, `Content-Length: {e}-{s}+1` |
| `bytes={s}-` (resume) | `206` | as above, `{e}` = `{total}-1` |
| Unsatisfiable | `416` | `Content-Range: bytes */{total}` |

`Content-Type: application/octet-stream` throughout. The open-ended form is the resume
case and must work.

## Failure handling and security

- Feature disabled → `404`, never `403`. A `403` confirms the feature exists.
- Unknown slug → `404`.
- File removed between scan and open → `404`.
- Unsatisfiable range → `416`.

All errors are raised as `AppError` and serialized by `errorResponse()`. Absolute
filesystem paths never appear in a message, following the precedent set by
`DownloadUrlPolicyError`, whose text deliberately omits the offending URL because those
strings surface in user-facing warnings.

Excluding `.gamarr-*.part` is a correctness requirement, not tidiness: the downloader
writes in-progress bytes to that name beside the eventual file, and serving one to DBI
would hand it a truncated NSP that fails hash verification partway through an install.

## Testing

- `slug-policy.test.ts` — extension filter, `.part` and dotfile exclusion, collision-suffix
  determinism.
- `service.test.ts` — fake scanner and fake title reader: index composition, fallback when
  title resolution misses, collision numbering.
- `handlers.test.ts` — fake service: disabled `404`, unknown-slug `404`, range arithmetic,
  `416`, header correctness.
- `switch-library-scanner.test.ts` — real temp directory: symlink-escape rejection, `.part`
  exclusion, depth limit.

No e2e coverage in v1. Exercising the risky part honestly would need multi-GiB fixtures,
and the range arithmetic is more precisely covered at the handler level.

## Operator setup

Add to `switch/dbi.config` on the SD card, under `[Network sources]`:

```
Gamarr=ApacheHTTP|http://<host>:8989/api/dbi/
```

The shipped `dbi.config` ships this line commented out as `Home server=ApacheHTTP|...`;
the trailing slash is required. Restart DBI to pick up the change.
