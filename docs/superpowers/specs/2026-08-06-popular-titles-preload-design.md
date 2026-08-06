# Popular Titles Preload Design

## Summary

Discover currently shows nothing until the operator picks a platform *and* types a
query. This feature fills that gap: selecting a platform immediately shows a shelf
of the most popular titles for that console, sourced from IGDB, cached in SQLite
with a seven-day TTL, and served stale-while-revalidate so the page is never slow.

The shelf is a browsing aid, not a new subsystem. It reuses the existing catalog
slice, the existing `games` cache, and the existing card markup. Cards link to the
same `/discover/[gameId]` detail page search results link to.

## Product goals

1. Selecting a platform on `/discover` renders popular titles for that platform
   with no typing.
2. Repeat visits to an already-seen platform cost zero upstream calls.
3. A popular card behaves exactly like a search-result card, including release
   search on the detail page.
4. Failure of the popular shelf never degrades catalog search.

## Non-goals

- No background scheduler or warm-on-boot job. Refresh is request-triggered only,
  consistent with Gamarr's deliberate absence of idle-time work.
- No multiple shelves ("top rated", "recently added"). One shelf, one signal.
- No pagination or "show more". A fixed 24 titles.
- No `game_type`/`category` filter to exclude DLC, bundles, mods or ports.
  Ranking by rating *count* already buries them, and `category` is deprecated in
  favour of `game_type`; guessing a second IGDB enum idiom immediately after the
  `platforms = {…}` exclusives bug is not worth the risk. Revisit if the shelf
  looks polluted in practice.
- No change to how search itself works.

## Choice of popularity signal

`/games` sorted by `total_rating_count` descending, filtered by
`platforms = (id)`.

Alternatives considered and rejected:

- **`follows`** — marked DEPRECATED on `/games` in the IGDB field reference.
- **`hypes`** — counts follows *before release* only; near-useless for retro
  platforms, which are the primary use case here.
- **`/popularity_primitives` (IGDB PopScore)** — the modern popularity API,
  recalculated daily from page visits and list additions. Rejected because it
  returns bare `game_id` + `value` with **no platform filter**. Scoping to a
  single console would mean fetching large global pages and intersecting
  client-side, with no guarantee that 24 titles for that platform appear at all,
  followed by a second `/games` call to hydrate. Two round trips, unbounded
  paging, a daily-changing signal under a seven-day TTL, and new stub-server
  modelling for e2e.

`total_rating_count` measures how many people scored a game, which for older
platforms reads as enduring fame rather than current buzz. That is the desired
behaviour for a catalog of retro titles. It lags on brand-new platforms; accepted.

## Data model

### `platform_popular_games`

Migration `0005`. One row per platform, shaped like the existing
`platform_settings` table and using the `jsonText<number[]>` convention already
used for `platform_ids`, `aliases` and `category_ids`.

```sql
CREATE TABLE platform_popular_games (
  platform_id INTEGER PRIMARY KEY
    REFERENCES platforms(id) ON DELETE CASCADE,
  game_ids    TEXT    NOT NULL DEFAULT '[]',
  fetched_at  INTEGER NOT NULL
);
```

- **Rank is array position.** A refresh is a single-row upsert rather than a
  delete-and-reinsert.
- **`game_ids = '[]'` is meaningful.** It records "IGDB was asked and returned
  nothing for this platform", which is distinguishable from never-fetched. Without
  it, an obscure platform would re-hit IGDB on every visit.
- **No foreign key on the ids themselves.** Hydration filters out any id no longer
  present in `games` rather than relying on referential integrity.

### Repository port additions

```ts
getPopular(platformId: number):
  { games: GameSearchResult[]; fetchedAt: number } | null;
replacePopular(platformId: number, gameIds: number[], now: number): void;
```

`getPopular` returns hydrated games, not raw ids: reading is two steps — read the
id array, then `SELECT … WHERE id IN (…)` against `games`, then re-sort in JS to
restore rank, because SQLite does not preserve `IN` order — and that ordering
detail belongs behind the repository boundary where Drizzle already lives. At 24
ids the cost is negligible.

The return type keeps the two cache states distinguishable: `null` means no row
has ever been written, while `{ games: [], fetchedAt }` means IGDB was asked and
returned nothing. The service needs that distinction to decide between awaiting a
refresh and serving an empty shelf.

The game rows themselves live in the existing `games` table, written by the
existing `upsertGames`. This is load-bearing: `/discover/[gameId]` reads the game
from the local repository and calls `notFound()` if it is absent, so a popular
card whose game was never upserted would be a dead link.

## Upstream call

`IgdbRequest` gains an optional structured sort:

```ts
sort?: { field: string; direction: "asc" | "desc" }
```

Structured rather than a raw string because igdb-api-node's builder takes two
arguments (`.sort('name', 'desc')`). `SdkIgdbExecutor` gains one line applying it.

`IgdbPort` gains:

```ts
popularGames(platformId: number, limit: number): Promise<GameSearchResult[]>
```

`IgdbClient.popularGames` reuses `searchGames`' exact field list, zod schema and
result mapping. It sends no `search`, and instead:

```
where: `platforms = (${platformId}) & total_rating_count != null`
sort:  { field: "total_rating_count", direction: "desc" }
limit: 24
```

The `platforms = (…)` membership idiom is the same one the exclusives fix landed
on — **not** `platforms = {…}`, which is Apicalypse exact-array-match and silently
hides every multiplatform game.

`search` and `sort` are never combined, since IGDB search imposes its own
relevance ordering.

## Service behaviour

```ts
async popular(platformId: number): Promise<GameSearchResult[]>
```

Validates exactly as `search` does — the platform must exist and be visible,
otherwise `validationError` — so the endpoint cannot be used to enumerate hidden
platforms.

Three cases against a seven-day TTL, judged with the injectable `now` the service
already takes, so tests move the clock rather than waiting:

| cache state | behaviour |
| --- | --- |
| fresh (age < 7d) | hydrate and return; zero upstream calls |
| stale (age >= 7d) | hydrate and return immediately, fire refresh without awaiting |
| miss (no row) | await the refresh, then read through and return |

A `fetched_at` in the future (clock skew) yields a negative age and is treated as
fresh.

### Refresh coordination

`catalogService()` constructs a **fresh `CatalogService` per request**, while
`igdbClient()` and the `IgdbRequestGate` are module-memoized. An in-flight guard
held on the service instance would therefore be a new empty map on every request
and would never fire.

The guard is instead a small injected port, following the same pattern `gate`
already uses for `IgdbClient` — defaulted per-instance, with `dependencies.ts`
injecting a module-scoped singleton:

```ts
export interface RefreshCoordinator {
  run(key: number, task: () => Promise<void>): Promise<void>;
}
```

`run` returns the in-flight promise if one exists for that key, otherwise starts
the task, stores it, and clears the entry once it settles. One signature serves
both call paths, and rejection handling falls out correctly:

- the **miss** path awaits it, so an IGDB failure propagates — correct, since the
  caller has nothing to display;
- the **stale** path attaches `.catch()` and drops the promise, so the same
  failure is swallowed and the stale list keeps serving — correct, and it prevents
  a background failure from surfacing as an unhandled rejection in the Next.js
  worker.

### Refresh task

In order:

1. `await provider.popularGames(platformId, 24)` — the only await.
2. Filter to `platformIds.includes(platformId)`, the same defence-in-depth
   `search` applies.
3. `repository.upsertGames(games, now)`.
4. `repository.replacePopular(platformId, ids, now)`.

Steps 3 and 4 are back-to-back synchronous better-sqlite3 writes with no await
between them, so they may share one short transaction. The network call is fully
outside it, per the standing rule that a transaction must never contain an
external await.

## API

`GET /api/catalog/popular?platformId=<n>`

Thin route shim at `src/app/api/catalog/popular/route.ts` (`runtime = "nodejs"`,
`dynamic = "force-dynamic"`) over `handleCatalogPopular` in the existing
`src/app/api/catalog/handlers.ts`. `popular(platformId)` is added to the
`CatalogHandlerService` structural interface so the handler stays injectable.

No `assertTrustedMutation`: it is a GET, consistent with `handleCatalogSearch`,
which is likewise a GET that writes through to `games`.

- Non-integer or non-positive `platformId` → 400 via `validationError`.
- Hidden or unknown platform → 400 via the service's own validation.
- Success → `GameSearchResult[]` with `cache-control: no-store`.

## User experience

`DiscoverScreen` gains `popular` and `popularState`, filled by a `useEffect` keyed
on `platformId`.

- The fetch runs under an `AbortController`. Without it, clicking rapidly through
  platforms lets a slow response land after a fast one and render the wrong shelf.
- The shelf renders in **its own section, outside the existing
  `aria-live="polite"` results region**. Injecting 24 cards into that live region
  would make a screen reader announce the whole grid on every platform click.
- The shelf shows only while `state === "idle"`, before any search. Submitting a
  search hides it. **Clearing the query box resets to idle and brings it back**,
  which makes the shelf the genuine empty state for search rather than a one-shot
  splash.
- Heading is `Popular on {platform name}`, resolved from the already-loaded
  visible platforms.
- Cards reuse `.game-grid` and `.game-card` verbatim, with an empty `q=` in the
  href. `/discover/[gameId]` already tolerates this via `query.q ?? ""` and its
  `returnTo` fallback, and release search on the detail page keys off
  `gameId` + `platformId`, not the query.
- No rank badges, so no meaning is encoded in position alone that is unavailable
  to assistive technology.

States:

- **loading** — "Loading popular titles…", with `aria-busy` on the section.
- **error** — a muted inline note, deliberately *not* the red `error-banner` that
  search failure uses. This is supplementary content and must not read as a broken
  page.
- **empty** — render nothing at all.

## Failure handling and security

- IGDB unavailable on a cold platform → `IgdbUpstreamError` → 502 through the
  existing `errorResponse`. Its message is already the generic "IGDB request
  failed". Catalog search continues to work independently.
- A failed background refresh is swallowed; the stale list keeps serving.
- Response bodies carry game data only — no upstream URLs, no credentials, no
  upstream error text. Nothing new is placed in client state or query keys.
- The endpoint respects platform visibility, so it exposes nothing that search
  does not already expose.

## Testing

### Unit — service

- fresh cache → provider never called
- miss → provider called once, games upserted, ids stored
- stale → stale rows returned *and* a refresh triggered
- two concurrent stale reads → exactly one provider call
- miss + provider throws → rejects
- stale + provider throws → still returns stale rows, no unhandled rejection
- hidden or unknown platform → `validationError`
- provider returns a game not on the platform → filtered out

### Unit — repository

- replace/read round trip preserves rank order
- empty list persists and stays distinguishable from a missing row
- ids absent from `games` are dropped on hydrate

### Unit — IGDB client

- `popularGames` sends the sort and the `platforms = (id)` membership where, and
  sends no `search`

### Unit — handler

- non-integer and non-positive `platformId` → 400
- happy path returns the array

### Component

- selecting a platform renders the popular shelf
- the shelf hides after a search and returns when the query is cleared
- the shelf is not inside the live region

### End-to-end

`tests/provider-server/server.ts` currently answers *any* `/games` request with a
single hard-coded game, so the popular path would pass accidentally without
proving anything. The stub must branch on search-versus-sort and return a distinct
popular fixture. The spec then asserts the shelf renders on platform selection,
and the existing `@axe-core/playwright` assertion covers the new section.

## Acceptance criteria

1. Selecting a visible platform on `/discover` with an empty query renders up to
   24 popular titles for that platform.
2. Re-selecting the same platform within seven days issues no IGDB request.
3. After seven days the next visit renders immediately from cache and refreshes in
   the background; the visit after that shows the refreshed list.
4. Concurrent visits to an expired platform issue exactly one IGDB request.
5. Clicking a popular card opens its detail page and release search works there.
6. With IGDB unreachable and no cache, the shelf shows a muted note and catalog
   search still functions.
7. Submitting a search hides the shelf; clearing the query restores it.
8. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` pass, including
   the axe assertion on `/discover`.

## References

- `docs/superpowers/specs/2026-07-31-gamarr-v1-design.md` — authoritative for the
  catalog slice, data model and security requirements this design extends.
- IGDB API field reference (`/games`, `/popularity_primitives`) via
  api-docs.igdb.com.
