# Console Debut Ranking Design

## Summary

The popular shelf currently ranks by IGDB's `total_rating_count`, which counts
ratings across every platform a game shipped on. Verified against live IGDB, the
PlayStation 2 shelf therefore surfaces Max Payne (#3), Mafia (#6) and Age of
Empires II (#14) — PC-origin titles whose rating volume comes from players who
never touched the PS2 port — while PS2-defining games like Jak & Daxter,
Ratchet & Clank, Gran Turismo, Devil May Cry, Okami and Burnout 3 are absent
from the top 24 entirely.

This design filters the ranked set to games that **debuted on the selected
console**, so the shelf reads as that console's canon rather than "famous games
you could also play there."

## Non-goals

- No new IGDB endpoint. See "Why not a different API".
- No change to the cache shape, TTL, stale-while-revalidate behaviour, or the
  `platform_popular_games` table. No migration.
- No change to catalog search.
- No user-facing toggle between ranking modes. One shelf, one rule.
- No persistence of the release timestamps used by the rule.

## Why not a different API

IGDB exposes no per-platform popularity or rating metric anywhere.

- `/games` carries `total_rating_count`, `rating_count` and
  `aggregated_rating_count`. All are global to the game, not per platform.
- `/popularity_primitives` (IGDB PopScore) returns only `game_id`, `value`,
  `popularity_type`, `external_popularity_source` and `calculated_at`. It has
  **no platform field**, and IGDB's own description states the data covers
  "the gaming market across all platforms".
- `/popularity_types` describes sources (Steam, IGDB) rather than platforms.
- `follows` is deprecated on `/games`; `hypes` counts pre-release interest only.

Platform relevance therefore has to be derived locally from data `/games`
already returns. No second request and no second endpoint is involved.

## The rule

For each candidate game, take the **earliest** dated `release_dates` entry for
the selected platform — a platform may carry several entries, one per region,
and a later regional release must not make a game look like a port of itself —
and compare that date to the game's `first_release_date`:

| condition | outcome |
| --- | --- |
| both present, `platformDate − firstReleaseDate ≤ 365 days` | keep |
| both present, difference exceeds the window | drop |
| either value missing | **keep** |

The missing-data branch is deliberate and load-bearing. Absent metadata is not
evidence of a late port, and hiding a real game because IGDB lacks a date is the
worse failure. This is not hypothetical: in the live PS2 top 24, **Resident
Evil 4 returned no release year for platform 8**, so it cannot be evaluated and
falls into this branch.

### Window length

**365 days.** Resident Evil 4's PS2 release trailed the GameCube original by
roughly nine months and is unambiguously a significant PS2 title, so a three- or
six-month window would cut it on the merits rather than on a technicality. A
twelve-month window still drops Mafia (PC 2002 → PS2 2004) and Age of Empires II
(PC 1999 → PS2 2001), which are the actual complaints.

The window is a single named constant. Its value must be validated against live
IGDB output for several platforms before it is considered settled.

## Fetch size and shelf length

`popularGames` fetches **100** games sorted by `total_rating_count desc`,
applies the debut rule, and keeps **every survivor**. There is no truncation.
The previous design's 24-item cap is removed.

A dense platform will therefore show roughly 85–95 cards rather than 24, and the
shelf becomes a full browse grid rather than a single row. That is the intent:
the shelf is the browse surface for a console, and an arbitrary cut at 24 hides
titles that passed the same relevance test as the ones above them.

100 is the fetch ceiling, not a target. Where IGDB holds only a few dozen games
for a console, a larger limit returns the same handful, so a short shelf there
reflects a short catalog rather than an under-fetch. Raising the ceiling is a
future change if a platform's shelf ever looks truncated at exactly 100
survivors, which would indicate real titles are being cut off.

### Consequences to accept

- The response for a dense platform grows to roughly 90 game objects. Each
  carries a summary string, so this is the largest response the app serves.
- `/discover` becomes a long scrolling page once a platform is selected. The
  search form sits above the shelf and is unaffected, but it is no longer the
  only thing on screen.
- The cached `game_ids` array holds up to 100 ids instead of 24. The column is
  already JSON text with no length constraint, so no schema change follows.

## Where the rule lives

The IGDB client is an adapter. "What counts as debuting on this console" is a
product decision and belongs in the service.

`IgdbPort.popularGames` therefore returns a richer candidate type:

```ts
export interface PopularCandidate extends GameSearchResult {
  firstReleaseDate: number | null;
  platformReleaseDate: number | null;
}
```

`CatalogService.refreshPopular` applies the window and then passes the surviving
plain `GameSearchResult` values to `upsertGames` and `replacePopular` exactly as
it does today. No count limit is applied.

Consequences:

- The two timestamps never reach SQLite or the browser, so there is no schema
  change and no migration.
- `GameSearchResult` is unchanged, so the games table, the detail page and
  catalog search are all untouched.
- The rule is unit-testable against plain objects with no IGDB involved.

## Upstream call

`GAME_FIELDS` gains `first_release_date` and `release_dates.date`. The existing
`release_dates.platform` and `release_dates.y` stay — `y` still drives the card's
display year, `date` drives the rule.

`gameSchema` gains `first_release_date: z.number().int().optional()` and a
`date` field on the `release_dates` element, both optional because IGDB omits
them freely.

The `where` clause, the sort, and the `platforms = (${platformId})` membership
idiom are unchanged. `limit` becomes 100.

`searchGames` is unaffected: it shares `GAME_FIELDS`, so it will request two
extra fields it ignores. That is a deliberate trade against maintaining two
divergent field lists.

## Cache and rollout

The cache shape, key, TTL and stale-while-revalidate behaviour are unchanged.
Existing rows are replaced naturally on their next refresh.

Because the deployed instance has already cached four platforms under the old
ranking, those rows should be deleted on deploy so the new ranking is visible
immediately rather than up to seven days later:

```sql
DELETE FROM platform_popular_games;
```

This is a cache-clear, not a migration — the table is disposable by design.

## Failure handling

Unchanged from the popular-titles design. A cold-platform IGDB failure still
surfaces as 502 through `errorResponse`; a failed background refresh is still
swallowed and the stale list keeps serving. The rule itself cannot throw: every
branch of the comparison is total, and missing data resolves to "keep".

An empty survivor set is written to the cache as an empty list, exactly as an
empty IGDB response is today, so the platform is not re-fetched on every visit.

## Testing

### Unit — the debut rule

- keeps a game whose platform release equals its first release
- keeps a game inside the window
- drops a game outside the window
- keeps a game with no `first_release_date`
- keeps a game with no `release_dates` entry for the platform
- keeps a game whose platform entry has no `date`
- picks the **earliest** platform entry when a platform has several
- boundary: exactly 365 days is kept, one second beyond is dropped

### Unit — service

- writes every survivor to `upsertGames` and `replacePopular`, applying no count
  limit — a 100-candidate response with 90 survivors caches 90 ids
- preserves the provider's rating-count order among survivors
- an all-dropped result writes an empty list rather than re-fetching

### Unit — IGDB client

- requests `first_release_date` and `release_dates.date`
- sends `limit: 100`
- parses a game whose `first_release_date` and `release_dates.date` are absent

### End-to-end

The stub server's popular fixture gains dates placing it inside the window, plus
a second fixture game outside the window that must not appear on the shelf.

### Live validation

Before the window constant is considered settled, query the deployed instance
for several platforms and confirm: PS2 no longer surfaces Mafia or Age of
Empires II, Resident Evil 4 still appears, and the PS2 shelf now reaches deep
enough to include the console-defining titles the old ranking buried — Jak &
Daxter, Ratchet & Clank, Gran Turismo, Devil May Cry, Okami and Burnout 3. Also
record the survivor count per platform, which is the evidence for whether the
100 ceiling is binding.

## Acceptance criteria

1. The PS2 shelf excludes Mafia and Age of Empires II.
2. The PS2 shelf still includes Resident Evil 4, despite its missing platform
   release date.
3. Dense platforms return every survivor rather than a capped 24, and the PS2
   shelf reaches far enough to include Jak & Daxter and Ratchet & Clank.
4. No migration is added and `GameSearchResult` is unchanged.
5. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` all pass,
   including the axe scan taken while the shelf is on screen.

## References

- `docs/superpowers/specs/2026-08-06-popular-titles-preload-design.md` — the
  design this amends. Cache, TTL and shelf behaviour are inherited from it.
- IGDB API field reference (`/games`, `/popularity_primitives`,
  `/popularity_types`) via api-docs.igdb.com.
