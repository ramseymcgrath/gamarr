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

## Over-fetching

Filtering after ranking means a request for 24 no longer yields 24, so
`popularGames` fetches **100** sorted by `total_rating_count desc`, applies the
rule, and takes the first 24 survivors.

100 is sufficient rather than arbitrary. Observed attrition in the live PS2 top
24 is roughly 10%, leaving about 90 survivors for a 24-slot shelf. Raising the
number does not help sparse platforms either: where IGDB holds only a few dozen
games for a console, a larger limit returns the same handful. A short shelf on
such a platform reflects a short catalog, not an under-fetch.

If validation shows a dense platform returning materially fewer than 24
survivors, that — not payload size — is the signal to raise the limit.

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

`CatalogService.refreshPopular` applies the window, truncates to 24, and then
passes plain `GameSearchResult` values to `upsertGames` and `replacePopular`
exactly as it does today.

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

- truncates to 24 after filtering
- writes only survivors to `upsertGames` and `replacePopular`
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
Empires II, Resident Evil 4 still appears, and each dense platform still returns
a full 24.

## Acceptance criteria

1. The PS2 shelf excludes Mafia and Age of Empires II.
2. The PS2 shelf still includes Resident Evil 4, despite its missing platform
   release date.
3. Dense platforms (PS2, PS1, PC, Switch) each return 24 titles.
4. No migration is added and `GameSearchResult` is unchanged.
5. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` all pass.

## References

- `docs/superpowers/specs/2026-08-06-popular-titles-preload-design.md` — the
  design this amends. Cache, TTL and shelf behaviour are inherited from it.
- IGDB API field reference (`/games`, `/popularity_primitives`,
  `/popularity_types`) via api-docs.igdb.com.
