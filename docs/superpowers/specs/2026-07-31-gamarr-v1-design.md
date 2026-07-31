# Gamarr v1 Design

## Summary

Gamarr is a self-hosted Arr-style application for finding and downloading games. It presents an IGDB-backed game catalog, filters discovery by platform, searches user-configured Newznab indexers for releases, sends a selected NZB to SABnzbd, and keeps a library and download-attempt history.

Version 1 is intentionally manual. It does not monitor indexers for newly posted releases, apply quality profiles, import or rename completed files, or support torrent clients.

## Product goals

- Search a polished game catalog by title and platform.
- Support every platform returned by IGDB, with local visibility and alias controls.
- Search multiple Newznab-compatible indexers for releases.
- Make platform matching understandable without introducing quality profiles.
- Send a selected NZB to SABnzbd safely and idempotently.
- Retain a library of game/platform pairs and the history of download attempts.
- Run as one Docker container with SQLite in a persistent `/config` volume.
- Prefer maintained SDKs and libraries over custom protocol implementations.

## Non-goals

- Automatic release monitoring or scheduled catalog searches.
- Quality, language, region, format, or upgrade profiles.
- Torznab, torrents, or qBittorrent.
- Completed-download importing, moving, renaming, or library filesystem scans.
- Multi-user authentication or Internet-facing deployment.
- Commercial metadata licensing.

## Deployment and trust model

Gamarr is designed for a trusted local network. It has no login screen in v1. Documentation will state that Internet exposure requires an authenticating reverse proxy and TLS.

The application ships as a multi-stage Docker image using the Next.js standalone server. It runs as a non-root user, listens on port 3000, and persists application data only beneath `/config`. The SQLite database lives at `/config/gamarr.db`. Next.js image optimization is disabled so runtime image caches do not require a writable application root. The container exposes a health endpoint, handles graceful shutdown, and supports a read-only root filesystem.

## Technology

- TypeScript and Next.js 16 App Router for the React UI and server route handlers.
- Node.js 24 as the container runtime.
- Stable Drizzle ORM with `better-sqlite3` and checked-in SQL migrations.
- Zod for settings, request, and third-party response validation.
- Tailwind CSS and shadcn/ui primitives for the interface.
- TanStack Query for interactive server state and refresh behavior.
- React Hook Form with the Zod resolver for settings forms.
- `igdb-api-node` for APICalypse query construction and IGDB requests, wrapped by a server-only token manager.
- `fast-xml-parser` for Newznab XML parsing.
- Native `fetch`, `FormData`, and `AbortSignal.timeout` for Newznab and SABnzbd HTTP operations.

Dependency selection is based on maintenance, protocol coverage, and security rather than avoiding all custom code. The available SABnzbd Node client is stale and lacks file-upload coverage, so Gamarr will use SABnzbd's documented HTTP API through a small typed adapter. Newznab likewise requires a small adapter, while XML parsing remains delegated to a maintained library.

## Architecture

The application is a modular monolith. Browser-facing route handlers call application services, and application services depend on narrow adapter interfaces rather than vendor implementations.

### Modules

- `catalog`: normalized games, platforms, and IGDB searches.
- `release-search`: query generation, concurrent indexer execution, normalization, deduplication, and match ranking.
- `downloads`: NZB retrieval, SABnzbd submission, reconciliation, and status transitions.
- `library`: saved game/platform entries and attempt history.
- `settings`: typed IGDB, Newznab, SABnzbd, and platform configuration.
- `db`: schema, repositories, transactions, and migrations.
- `integrations/igdb`: Twitch client-credentials token management and IGDB mapping.
- `integrations/newznab`: capabilities, search, download, and XML mapping.
- `integrations/sabnzbd`: connection test, NZB upload, queue lookup, and history lookup.

All integration modules import `server-only`. Credentials and raw provider responses cannot be imported into client components.

## User experience

Primary navigation contains **Library**, **Discover**, **Activity**, and **Settings**.

### First-run setup

The resumable `/setup` flow derives readiness from current configuration rather than storing a one-time completion flag. Library and Activity remain reachable while setup is incomplete. Discover shows incomplete readiness checks with links to the required step.

The setup flow has four required steps:

1. IGDB: open the Twitch Developer Portal, enter a Twitch client ID and client secret, then connect and test.
2. Platforms: synchronize IGDB platforms and choose initial visible platforms from a searchable grouped list.
3. Indexers: add one or more Newznab endpoints with URL, API key, optional category IDs, and enabled state, then test each connection.
4. SABnzbd: enter URL, API key, and optional default category, then connect and test.

The initial connection action is **Save and test**. Later credential or URL changes make the prior test result stale until the user tests again. Each connection displays saved-but-untested, testing, success with timestamp, timeout, and invalid-credential states.

IGDB does not provide a user-facing "Sign in with Twitch" flow for this API. Gamarr obtains and refreshes app access tokens automatically after the user supplies application credentials.

### Discover

The user selects a visible IGDB platform and enters a title. Results show cover art, title, release year, genres, and platforms. Platform selection is required before release search so that the same title on different systems remains unambiguous.

Selecting a game opens `/discover/{gameId}` with metadata and a **Search releases** action. The selected platform, original query, and return context remain in URL parameters so reload, browser back, and **Search again** are deterministic. Invalid games and hidden platforms show recoverable navigation rather than a blank page.

Discover renders a short recent/visible platform set as archive media-spine tabs and provides a searchable **All platforms** combobox for overflow. The control supports arrow keys, Home/End, selected-state text, automatic scroll into view, and a non-horizontal-scroll fallback. A no-visible-platform state links to platform setup.

### Release search

Gamarr builds bounded queries from:

- Canonical title.
- Up to three IGDB alternate titles.
- Release year when the canonical title is not unique within the selected platform.
- Configured aliases for the selected platform.
- Configured Newznab category IDs for that platform or indexer.

Gamarr issues at most eight query variants per indexer. Enabled indexers are searched concurrently with a 10-second per-indexer timeout and a 20-second overall deadline. Results are normalized and deduplicated by GUID, download identity, and normalized release title. A deduplicated result retains all contributing indexer sources. The default order is match class, score signals, publication time descending, size ascending, then normalized title and source ID for deterministic ties.

Ranking uses transparent signals rather than quality profiles:

- Canonical or alternate title match.
- Selected platform alias match.
- Conflicting platform alias penalty.
- Release-year evidence.
- Newznab category evidence.

No result is silently removed solely for a weak match. The text labels **Strong**, **Possible**, and **Conflicting** accompany supporting and conflicting evidence; color is never the only signal. The user may sort by **Best match**, **Newest**, or **Smallest** without creating a profile.

Each result shows release name, source count, indexers, age, size, category, and match explanation in user language. The confirmation dialog permits source selection when a result exists on multiple indexers and includes the SABnzbd category. The UI distinguishes no results, partial indexer timeout, and total indexer failure.

Browser responses receive only opaque, random, 30-minute candidate IDs. Server-side candidate records bind the indexer and configuration revision, GUID, title, size, normalized same-origin download path, and source metadata. Raw download URLs, provider payloads, and credentials never enter browser DTOs.

### Download submission

Gamarr resolves the opaque candidate, reconstructs the download request from saved indexer configuration, downloads the NZB on the server, validates the response with a default 20 MiB maximum size, and uploads the bytes to SABnzbd. The maximum is configurable from 1 to 100 MiB. This avoids passing indexer credentials to SABnzbd in a release URL.

Candidate download policy permits only HTTP(S), rejects userinfo and fragments, limits XML and NZB response bytes while streaming, and validates each redirect manually. Downloads remain on the configured indexer origin unless the operator explicitly approves another origin. Metadata, link-local, multicast, and loopback destinations are rejected unless that exact endpoint is the configured service; private RFC1918 services remain supported.

Submission creates or updates the library entry and creates a download attempt in a database transaction before contacting SABnzbd. Each confirmation action generates a unique submission key and canonical request fingerprint that are reused by browser retries. Double-clicks and repeated requests with the same key and fingerprint return the existing attempt; key reuse with different input returns `409 Conflict`. A deliberate later **Search again** action generates a new key.

Before network dispatch, Gamarr commits `Submitting`, records `sab_request_started_at`, and sends a stable `gamarr-{attemptId}` marker in SABnzbd's `nzbname`. On an acknowledgement containing exactly one nonempty job ID, the attempt becomes `Queued`. Any failure after dispatch begins becomes `Unknown`. At startup, stale `Submitting` attempts become `Unknown`; Gamarr reconciles them by exact marker against queue/history and never automatically resubmits them.

### Library

A library entry is unique by IGDB game ID and IGDB platform ID. Cards show cover, title, platform, latest status, latest successful release, and completion date.

The detail page shows:

- Cached IGDB metadata.
- Latest successful release.
- Every download attempt and its status.
- Failure or ambiguity details.
- **Search again** to select another release without discarding history.
- A remove action that removes the Gamarr library record only and clearly states that it does not delete SABnzbd history or downloaded files.

The latest successful attempt is featured on the card; older attempts remain in the detail-page history.

### Activity

Activity presents recent attempts across all games. It can be filtered by active, completed, failed, or unknown status. Active rows show progress when SABnzbd reports it.

## Download lifecycle

Attempt states are:

- `Pending`: committed locally but not yet submitted.
- `Submitting`: network dispatch has begun and carries a durable SABnzbd marker.
- `Queued`: accepted by SABnzbd.
- `Downloading`: present in the active SABnzbd queue.
- `Completed`: present in SABnzbd history with a successful status.
- `Failed`: rejected by SABnzbd or completed unsuccessfully.
- `Unknown`: submission or reconciliation had an ambiguous outcome.

Reconciliation runs through a same-origin POST action:

- Immediately after submission.
- When the user opens Library or Activity and the UI explicitly requests refresh.
- On explicit refresh.
- On a client-side interval while active attempts are visible.

There is no always-running scheduler when Gamarr is idle.

## Data model

### `games`

- IGDB game ID, canonical title, slug, summary, cover ID, release year, genres, alternate titles, and cache timestamp.

### `platforms`

- IGDB platform ID, name, abbreviation, generation, provider checksum, and last synchronized timestamp.

### `platform_settings`

- Platform ID, visible flag, search aliases, and optional Newznab category IDs.

Platforms synchronize during first-run IGDB setup and on manual refresh. Opening platform settings refreshes a platform cache older than seven days; there is no background synchronization job.

### `library_entries`

- ID, game ID, platform ID, and created and updated timestamps. The latest successful attempt is derived from attempts belonging to the entry.
- Unique constraint on game ID plus platform ID.

### `release_candidates`

- Random candidate ID, expiry, indexer ID and configuration revision, GUID, title, size, normalized download path, category, and source snapshot.

### `download_attempts`

- ID, library entry ID, submission key, request fingerprint, normalized status, release title, immutable indexer name/source snapshot, nullable indexer ID, Newznab GUID, size, category, SABnzbd connection revision, stable marker, SABnzbd job ID, progress, failure detail, and lifecycle timestamps.
- Unique constraint on submission key and partial unique constraint on SAB connection revision plus SAB job ID.
- Terminal states never regress. Progress and size have database checks. All timestamps are UTC.

### `indexers`

- ID, name, base URL, API key, enabled flag, category IDs, timeout, and last connection-test result.

### `igdb_settings`

- Singleton client ID, client secret, cached access token, token expiry, and last connection-test result.

### `sabnzbd_settings`

- Singleton base URL, API key, default category, and last connection-test result.

Sensitive fields are omitted from read models and logs. Settings updates use explicit `retain`, `replace`, or `clear` secret operations, so the browser never needs to read a saved secret back. Secrets are plaintext in v1 under the trusted `/config` volume; the directory is mode `0700`, the database is mode `0600`, and documentation warns that host access and backups contain secrets. IGDB access tokens remain in process memory rather than SQLite.

## Failure handling and security

- All external calls have explicit connect and response timeouts.
- IGDB access tokens are cached and refreshed before expiry. Safe transient failures and rate limits use at most two retries with jitter.
- An indexer failure produces a per-indexer warning without discarding successful results from other indexers.
- Third-party responses are normalized and validated before entering the domain layer.
- NZB downloads have response-type and size checks and are never written to disk.
- Database transactions protect related library and attempt changes, contain no external `await`, and stay short because `better-sqlite3` is synchronous.
- Retryable, permanent, partial, and ambiguous failures have distinct UI messages.
- State-changing routes use non-GET methods, require JSON or multipart content as appropriate, and enforce an operator-configured exact scheme/host/port allowlist. Unknown `Host` values are rejected before routing. Forwarded headers are trusted only when an explicit trusted-proxy mode is enabled.
- Library and Activity GET routes are read-only. Reconciliation, connection tests, platform sync, delete, and refresh use guarded POST/PUT/DELETE routes.
- Credentials are redacted in structured logs and never included in browser responses.
- URLs and secrets are not placed in client-side query keys, analytics, or error reports.
- SQLite enables foreign keys, WAL mode, and a busy timeout.
- Reconciliation is single-flight and rate-limited; status writes use monotonic compare-and-set rules so stale responses cannot overwrite terminal states.

Because administrators intentionally configure services on the local network, integration URLs may use private addresses and HTTP. The settings UI recommends HTTPS for non-local endpoints.

## Accessibility

Gamarr targets WCAG 2.2 AA. It provides a skip link, semantic landmarks, one page `h1`, route-specific titles, visible focus, route-change focus management, forced-colors support, reduced motion, 200% zoom, and 320 CSS-pixel reflow. Search updates use live regions, loading containers expose busy state, progress has semantic values, and error summaries receive focus and link to affected fields. Dialogs trap and restore focus, support Escape, and name destructive consequences. Status and rank always combine text, icon or shape, and color.

## Testing

### Unit tests

Vitest covers query generation, aliases, title normalization, ranking explanations, deduplication, state transitions, idempotency decisions, and Zod schemas.

### Component tests

React Testing Library covers forms, credential-retention behavior, result warnings, confirmation dialogs, library cards, attempt history, and failure states.

### Integration and contract tests

MSW and sanitized fixtures emulate IGDB, Newznab, and SABnzbd for in-process tests. A real local fixture HTTP server started by Playwright global setup serves Twitch, IGDB, Newznab, and SAB responses to the separately running Next server. Temporary SQLite databases exercise migrations, constraints, transactions, and repository behavior.

Required cases include:

- The same title on multiple platforms.
- Alternate titles, punctuation, and regional naming.
- Newznab namespaces, missing optional attributes, and malformed XML.
- Duplicate releases across indexers.
- Partial indexer failure and overall timeout behavior.
- IGDB token expiry and rate limiting.
- SABnzbd acceptance, rejection, progress, completion, failure, and ambiguous timeouts.
- Repeated submission requests.
- Concurrent repeated submissions, same-key/different-input conflict, crash and restart around dispatch.
- Host allowlist, DNS rebinding, hostile provider URLs, redirects, and response-size limits.
- Secret redaction from API responses and logs.

### End-to-end tests

Playwright covers first-run setup, catalog search, platform filtering, release search, SABnzbd submission, library creation, reconciliation, attempt history, and search-again behavior.

Automated accessibility checks use `@axe-core/playwright`. Release verification also includes keyboard-only and VoiceOver smoke passes.

### Packaging tests

The built container is smoke-tested with a read-only root filesystem for health, non-root execution, initial and repeated migration, `/config` ownership and persistence, restart behavior, signal forwarding, and graceful shutdown. Deployment is single-replica on a local filesystem. Documentation includes WAL-aware backup and restore. Default tests require no live third-party credentials. Explicit opt-in tests may target real services.

## Acceptance criteria

Gamarr v1 is complete when a fresh Docker deployment can:

1. Configure and test IGDB, at least one Newznab indexer, and SABnzbd.
2. Synchronize IGDB platforms and control their visibility and aliases.
3. Search the IGDB catalog by title within a selected platform.
4. Search all enabled indexers and explain normalized result ranking.
5. Submit a selected NZB to SABnzbd without exposing indexer credentials.
6. Prevent duplicate submissions caused by repeated requests.
7. Display the game/platform pair in Library with complete attempt history.
8. Reconcile active jobs to completed or failed SABnzbd history.
9. Preserve data and settings across container restart.
10. Pass unit, component, integration, end-to-end, and container smoke tests.

## Future extension seams

The adapter and domain boundaries allow later additions without changing v1 contracts:

- Automated monitored searches.
- Quality, region, language, and format profiles.
- RAWG or another catalog provider.
- Torznab and torrent clients.
- Importing and renaming completed files.
- Filesystem library scans.
- Multi-user authentication.

These capabilities are not stubbed into the v1 interface.

## External constraints

- IGDB requires a Twitch account, a confidential Twitch developer application, and client credentials. Gamarr can automate token lifecycle but cannot create those credentials for the user.
- IGDB's free API is for non-commercial use under Twitch's developer terms.
- Gamarr only connects to indexers and download services configured by the administrator. It does not bundle indexers, content sources, or credentials.

## References

- [IGDB API getting started and authentication](https://api-docs.igdb.com/)
- [Next.js App Router route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Next.js Docker example with standalone output](https://github.com/vercel/next.js/tree/canary/examples/with-docker)
- [Drizzle ORM SQLite documentation](https://orm.drizzle.team/docs/get-started-sqlite)
