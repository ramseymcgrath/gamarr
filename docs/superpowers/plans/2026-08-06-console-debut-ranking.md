# Console Debut Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank the popular shelf by games that debuted on the selected console, instead of by a global rating count that lets late ports of PC hits outrank the console's own defining titles.

**Architecture:** `IgdbPort.popularGames` starts returning a `PopularCandidate` — a `GameSearchResult` plus the game's first release date anywhere and its earliest dated release on the selected platform. A pure `debutedOnPlatform` predicate decides whether the gap falls inside a 365-day window. `CatalogService.refreshPopular` fetches 100 candidates, applies the predicate, and caches every survivor with no count cap.

**Tech Stack:** Next.js App Router, better-sqlite3 + Drizzle, zod, vitest, Playwright + @axe-core/playwright, igdb-api-node.

**Spec:** `docs/superpowers/specs/2026-08-06-console-debut-ranking-design.md`

## Global Constraints

- Node **24 or newer** (a floor, not a pin — this machine runs v26.5.0 and the
  full suite passes on it) and pnpm via corepack. Commands: `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.
- **No migration in this feature.** `GameSearchResult` and the `platform_popular_games` table are unchanged. If you find yourself running `pnpm db:generate`, stop — something has gone wrong.
- **IGDB dates are unix SECONDS, not milliseconds.** The window constant is in seconds. Do not multiply by 1000.
- Apicalypse platform filtering uses `platforms = (id)` — array **inclusion**. Never `platforms = {id}`.
- better-sqlite3 is synchronous; a transaction must never contain an `await`.
- Features reach outside only through ports. Only `dependencies.ts` binds a port to an adapter.
- Throw `AppError` / `validationError`; never let a raw upstream message reach a response.
- Tests colocate as `*.test.ts`. `clearMocks`/`restoreMocks` are global — no hand-rolled spy teardown. `vitest.config.ts` does **not** set `unstubGlobals`, so any `vi.stubGlobal` needs its own `vi.unstubAllGlobals()` teardown.
- Accessibility is WCAG 2.2 AA, asserted by axe in e2e.

## File Structure

**Create:**
- `src/features/catalog/debut-window.ts` — the pure predicate and its window constant. No imports, no I/O, one responsibility.
- `src/features/catalog/debut-window.test.ts`

**Modify:**
- `src/features/catalog/models.ts` — add `PopularCandidate`.
- `src/features/catalog/ports.ts` — `popularGames` returns `PopularCandidate[]`.
- `src/integrations/igdb/client.ts` — two extra requested fields, two optional schema fields, a `toPopularCandidate` mapper.
- `src/features/catalog/service.ts` — fetch 100, filter by debut, drop the 24 cap.
- `src/integrations/igdb/client.test.ts`, `src/features/catalog/service.test.ts` — extend.
- `tests/provider-server/server.ts` — dated fixtures, one inside the window and one outside.
- `tests/e2e/setup-and-download.spec.ts` — assert the late port is absent.

---

### Task 1: The debut predicate

**Files:**
- Create: `src/features/catalog/debut-window.ts`
- Test: `src/features/catalog/debut-window.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const DEBUT_WINDOW_SECONDS: number;       // 365 * 24 * 60 * 60
  export interface DebutDates {
    firstReleaseDate: number | null;
    platformReleaseDate: number | null;
  }
  export function debutedOnPlatform(
    dates: DebutDates,
    windowSeconds?: number
  ): boolean;
  ```
  Tasks 2 and 3 both depend on these exact names.

- [ ] **Step 1: Write the failing tests**

Create `src/features/catalog/debut-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DEBUT_WINDOW_SECONDS,
  debutedOnPlatform
} from "@/features/catalog/debut-window";

const DAY = 24 * 60 * 60;
const FIRST = 1_000_000_000;

describe("debutedOnPlatform", () => {
  it("keeps a game released on the platform the day it launched anywhere", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST
    })).toBe(true);
  });

  it("keeps a port that arrived inside the window", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + 200 * DAY
    })).toBe(true);
  });

  it("keeps a release exactly on the window boundary", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + DEBUT_WINDOW_SECONDS
    })).toBe(true);
  });

  it("drops a port one second past the window", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + DEBUT_WINDOW_SECONDS + 1
    })).toBe(false);
  });

  it("drops a port that arrived years later", () => {
    // Age of Empires II: PC 1999, PS2 2001.
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST + 730 * DAY
    })).toBe(false);
  });

  it("keeps a game with no first release date", () => {
    expect(debutedOnPlatform({
      firstReleaseDate: null,
      platformReleaseDate: FIRST
    })).toBe(true);
  });

  it("keeps a game with no dated release on the platform", () => {
    // Resident Evil 4 returned no PS2 release year from live IGDB and is
    // unambiguously a PS2 title. Undecidable must mean keep, not hide.
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: null
    })).toBe(true);
  });

  it("keeps a platform release dated before the first release", () => {
    // IGDB data is not always self-consistent; a negative gap is inside any
    // window and must not be treated as a late port.
    expect(debutedOnPlatform({
      firstReleaseDate: FIRST,
      platformReleaseDate: FIRST - 30 * DAY
    })).toBe(true);
  });

  it("honours an explicit window override", () => {
    expect(debutedOnPlatform(
      { firstReleaseDate: FIRST, platformReleaseDate: FIRST + 10 * DAY },
      5 * DAY
    )).toBe(false);
  });

  it("uses a 365 day window by default", () => {
    expect(DEBUT_WINDOW_SECONDS).toBe(365 * 24 * 60 * 60);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/features/catalog/debut-window.test.ts`
Expected: FAIL — cannot resolve `@/features/catalog/debut-window`.

- [ ] **Step 3: Implement the predicate**

Create `src/features/catalog/debut-window.ts`:

```ts
/**
 * How long after a game's first release anywhere a console release still
 * counts as that console's debut rather than a later port.
 *
 * IGDB timestamps are unix SECONDS, so this constant is in seconds.
 *
 * 365 days rather than the three or six months you might expect: Resident
 * Evil 4 reached the PS2 roughly nine months after the GameCube original and
 * is unambiguously a significant PS2 title, so a shorter window would cut it
 * on the merits. A year still drops Mafia (PC 2002, PS2 2004) and Age of
 * Empires II (PC 1999, PS2 2001), which are the cases this rule exists for.
 */
export const DEBUT_WINDOW_SECONDS = 365 * 24 * 60 * 60;

export interface DebutDates {
  firstReleaseDate: number | null;
  platformReleaseDate: number | null;
}

export function debutedOnPlatform(
  dates: DebutDates,
  windowSeconds: number = DEBUT_WINDOW_SECONDS
): boolean {
  const { firstReleaseDate, platformReleaseDate } = dates;
  // Absent metadata is not evidence of a late port, and hiding a real game
  // because IGDB lacks a date is the worse failure. Undecidable means keep.
  if (firstReleaseDate === null || platformReleaseDate === null) return true;
  return platformReleaseDate - firstReleaseDate <= windowSeconds;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/features/catalog/debut-window.test.ts`
Expected: PASS, all ten tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/catalog/debut-window.ts src/features/catalog/debut-window.test.ts
git commit -m "feat(catalog): add a console debut window predicate"
```

---

### Task 2: Candidate dates from IGDB

**Files:**
- Modify: `src/features/catalog/models.ts`
- Modify: `src/features/catalog/ports.ts`
- Modify: `src/integrations/igdb/client.ts`
- Test: `src/integrations/igdb/client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // src/features/catalog/models.ts
  export interface PopularCandidate extends GameSearchResult {
    firstReleaseDate: number | null;
    platformReleaseDate: number | null;
  }
  // src/features/catalog/ports.ts — IgdbPort
  popularGames(platformId: number, limit: number): Promise<PopularCandidate[]>;
  ```
  Task 3 filters these. `PopularCandidate` extends `GameSearchResult`, so it stays assignable anywhere a `GameSearchResult` is expected.

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/igdb/client.test.ts`:

```ts
  it("requests the dates the debut rule needs", async () => {
    const requests: IgdbRequest[] = [];
    const executor: IgdbExecutor = {
      execute: async (_token, request) => {
        requests.push(request);
        return [];
      }
    };

    await new IgdbClient(new FixedToken(), executor).popularGames(8, 100);

    expect(requests[0]!.fields).toContain("first_release_date");
    expect(requests[0]!.fields).toContain("release_dates.date");
    expect(requests[0]!.limit).toBe(100);
  });

  it("reports the earliest dated platform release across regions", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 1,
        name: "Regional",
        slug: "regional",
        platforms: [8],
        first_release_date: 1_000_000_000,
        release_dates: [
          // Deliberately out of order, and one entry belongs to another
          // platform. A later regional release must not make a game look
          // like a port of itself.
          { platform: 8, y: 2002, date: 1_030_000_000 },
          { platform: 6, y: 2001, date: 1_000_000_000 },
          { platform: 8, y: 2001, date: 1_010_000_000 }
        ]
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .popularGames(8, 100);

    expect(games[0]).toMatchObject({
      firstReleaseDate: 1_000_000_000,
      platformReleaseDate: 1_010_000_000
    });
  });

  it("reports null dates when IGDB omits them", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 2,
        name: "Undated",
        slug: "undated",
        platforms: [8],
        // No first_release_date, and the platform entry carries no date —
        // the shape live IGDB returned for Resident Evil 4 on PS2.
        release_dates: [{ platform: 8, y: 2005 }]
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .popularGames(8, 100);

    expect(games[0]).toMatchObject({
      firstReleaseDate: null,
      platformReleaseDate: null
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/integrations/igdb/client.test.ts`
Expected: FAIL — `fields` lacks `first_release_date`, and the returned objects have no `firstReleaseDate` property.

- [ ] **Step 3: Add the model**

In `src/features/catalog/models.ts`, after `GameSearchResult`:

```ts
/**
 * A popular-shelf candidate before the debut rule has been applied. The two
 * timestamps exist only to decide whether the game debuted on the selected
 * platform; they are never persisted and never reach the browser.
 */
export interface PopularCandidate extends GameSearchResult {
  firstReleaseDate: number | null;
  platformReleaseDate: number | null;
}
```

- [ ] **Step 4: Widen the port**

In `src/features/catalog/ports.ts`, add `PopularCandidate` to the type import from `@/features/catalog/models` and change the `IgdbPort` member to:

```ts
  popularGames(platformId: number, limit: number): Promise<PopularCandidate[]>;
```

- [ ] **Step 5: Request and parse the dates**

In `src/integrations/igdb/client.ts`, add `PopularCandidate` to the type import from `@/features/catalog/models`.

Extend `gameSchema` — add `first_release_date` and a `date` on the release-date element. Both are optional because IGDB omits them freely:

```ts
const gameSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().optional(),
  platforms: z.array(z.number().int().positive()).default([]),
  genres: z.array(z.object({ name: z.string() })).default([]),
  alternative_names: z.array(z.object({ name: z.string() })).default([]),
  first_release_date: z.number().int().optional(),
  release_dates: z.array(z.object({
    platform: z.number().int().positive(),
    y: z.number().int().optional(),
    date: z.number().int().optional()
  })).default([]),
  cover: z.object({ image_id: z.string() }).optional()
});
```

Extend `GAME_FIELDS` with the two new fields:

```ts
const GAME_FIELDS = [
  "id",
  "name",
  "slug",
  "summary",
  "platforms",
  "genres.name",
  "alternative_names.name",
  "first_release_date",
  "release_dates.platform",
  "release_dates.y",
  "release_dates.date",
  "cover.image_id"
];
```

`searchGames` shares `GAME_FIELDS` and will now request two fields it ignores. That is deliberate — one field list is easier to keep correct than two that drift.

- [ ] **Step 6: Add the candidate mapper**

Still in `src/integrations/igdb/client.ts`, add directly after `toGameSearchResult`:

```ts
function toPopularCandidate(
  game: z.infer<typeof gameSchema>,
  platformId: number
): PopularCandidate {
  // A platform can carry several dated entries, one per region. The earliest
  // is the console's debut; taking a later regional date would make a game
  // look like a port of itself.
  const platformDates = game.release_dates
    .filter((date) => date.platform === platformId && date.date !== undefined)
    .map((date) => date.date as number);
  return {
    ...toGameSearchResult(game, platformId),
    firstReleaseDate: game.first_release_date ?? null,
    platformReleaseDate: platformDates.length > 0
      ? Math.min(...platformDates)
      : null
  };
}
```

- [ ] **Step 7: Return candidates from popularGames**

Change the signature and the final map of `popularGames`. Leave the `where`, `sort` and their comments exactly as they are:

```ts
  async popularGames(
    platformId: number,
    limit: number
  ): Promise<PopularCandidate[]> {
```

and its last line:

```ts
    return games.map((game) => toPopularCandidate(game, platformId));
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test src/integrations/igdb/client.test.ts`
Expected: PASS, all ten tests.

- [ ] **Step 9: Typecheck and fix the service test fake**

Run: `pnpm typecheck`
Expected: FAIL. **Two** sites in `src/features/catalog/service.test.ts` return
`popularGames` results and neither satisfies `PopularCandidate` yet. Fix both.

**(a)** The shared `provider` fake near the top of the file — add the two
fields to the object it returns:

```ts
  popularGames: async () => [
    {
      id: 7346,
      name: "Metroid Prime 4: Beyond",
      slug: "metroid-prime-4-beyond",
      summary: null,
      coverUrl: null,
      releaseYear: 2025,
      genres: ["Adventure"],
      alternativeNames: ["Metroid Prime 4"],
      platformIds: [130],
      firstReleaseDate: null,
      platformReleaseDate: null
    }
  ]
```

**(b)** The inline override inside the test named `drops popular games that are
not on the requested platform` — this one exists to prove the platform filter
works, so its dates are irrelevant and nulls keep it focused:

```ts
      popularGames: async () => [{
        id: 42,
        name: "Wrong platform",
        slug: "wrong-platform",
        summary: null,
        coverUrl: null,
        releaseYear: null,
        genres: [],
        alternativeNames: [],
        platformIds: [8],
        firstReleaseDate: null,
        platformReleaseDate: null
      }]
```

Re-run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/features/catalog/models.ts src/features/catalog/ports.ts src/integrations/igdb/client.ts src/integrations/igdb/client.test.ts src/features/catalog/service.test.ts
git commit -m "feat(igdb): return release dates alongside popular candidates"
```

---

### Task 3: Filter by debut and drop the cap

**Files:**
- Modify: `src/features/catalog/service.ts`
- Test: `src/features/catalog/service.test.ts`

**Interfaces:**
- Consumes: `debutedOnPlatform` and `DEBUT_WINDOW_SECONDS` (Task 1); `PopularCandidate` and the widened `IgdbPort.popularGames` (Task 2).
- Produces: no new exports. `CatalogService.popular` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/catalog/service.test.ts`. Add the import:

```ts
import { DEBUT_WINDOW_SECONDS } from "@/features/catalog/debut-window";
```

and this helper above the `describe`, next to the existing helpers:

```ts
function candidate(
  id: number,
  overrides: Partial<{
    firstReleaseDate: number | null;
    platformReleaseDate: number | null;
  }> = {}
) {
  return {
    id,
    name: `Game ${id}`,
    slug: `game-${id}`,
    summary: null,
    coverUrl: null,
    releaseYear: null,
    genres: [],
    alternativeNames: [],
    platformIds: [130],
    firstReleaseDate: 1_000_000_000,
    platformReleaseDate: 1_000_000_000,
    ...overrides
  };
}
```

Then the tests:

```ts
  it("drops a late port and keeps a console debut", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => [
        candidate(1),
        candidate(2, {
          platformReleaseDate: 1_000_000_000 + DEBUT_WINDOW_SECONDS + 1
        }),
        candidate(3, {
          platformReleaseDate: 1_000_000_000 + DEBUT_WINDOW_SECONDS
        })
      ]
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 3 })
    ]);
  });

  it("keeps a candidate whose dates IGDB omitted", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => [
        candidate(1, { firstReleaseDate: null }),
        candidate(2, { platformReleaseDate: null })
      ]
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 })
    ]);
  });

  it("caches every survivor with no count cap and keeps provider order", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const many = Array.from({ length: 90 }, (_, index) => candidate(index + 1));
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => many
    }, () => 1_000);

    await service.popular(130);

    expect(repository.popular.get(130)?.gameIds).toHaveLength(90);
    expect(repository.popular.get(130)?.gameIds.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("asks the provider for 100 candidates", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const limits: number[] = [];
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async (_platformId: number, limit: number) => {
        limits.push(limit);
        return [candidate(1)];
      }
    }, () => 1_000);

    await service.popular(130);

    expect(limits).toEqual([100]);
  });

  it("caches an empty list when every candidate is a late port", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    let calls = 0;
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => {
        calls += 1;
        return [candidate(1, {
          platformReleaseDate: 1_000_000_000 + DEBUT_WINDOW_SECONDS + 1
        })];
      }
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([]);
    // The empty result is cached, so a second visit must not re-ask IGDB.
    await expect(service.popular(130)).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/features/catalog/service.test.ts`
Expected: FAIL — the late port is still returned, and the provider is asked for 24 rather than 100.

- [ ] **Step 3: Apply the rule**

In `src/features/catalog/service.ts`, add the import:

```ts
import { debutedOnPlatform } from "@/features/catalog/debut-window";
```

Replace the `POPULAR_LIMIT` constant:

```ts
/**
 * Candidates requested per refresh. Filtering happens after ranking, so this
 * is a ceiling rather than the shelf length — every survivor is kept.
 */
const POPULAR_FETCH_LIMIT = 100;
```

Replace `refreshPopular`:

```ts
  private async refreshPopular(platformId: number): Promise<void> {
    const games = (
      await this.getProvider().popularGames(platformId, POPULAR_FETCH_LIMIT)
    )
      .filter((game) => game.platformIds.includes(platformId))
      // IGDB has no per-platform popularity metric, so total_rating_count is
      // a global count: without this, a late port of a PC hit outranks the
      // console's own defining titles. Verified against live IGDB, the PS2
      // shelf led with Max Payne, Mafia and Age of Empires II.
      .filter((game) => debutedOnPlatform(game));
    // Everything past this point is synchronous better-sqlite3 work; the only
    // await in this method is the network call above.
    //
    // `games` is PopularCandidate[], which is assignable to GameSearchResult[].
    // The repository writes an explicit column list, so the two timestamps are
    // dropped on the way to SQLite and never reach the browser.
    const now = this.now();
    this.repository.upsertGames(games, now);
    this.repository.replacePopular(
      platformId,
      games.map((game) => game.id),
      now
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/features/catalog/service.test.ts`
Expected: PASS, all sixteen tests.

- [ ] **Step 5: Verify the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. `pnpm lint` must report 0 errors; the single pre-existing warning in `.remember/tmp/last-ndc.ts` is not ours.

- [ ] **Step 6: Commit**

```bash
git add src/features/catalog/service.ts src/features/catalog/service.test.ts
git commit -m "feat(catalog): rank the popular shelf by console debut"
```

---

### Task 4: End-to-end coverage

**Files:**
- Modify: `tests/provider-server/server.ts`
- Modify: `tests/e2e/setup-and-download.spec.ts`

**Interfaces:**
- Consumes: the shelf rendered by `DiscoverScreen`.
- Produces: nothing downstream.

- [ ] **Step 1: Give the stub a debut and a late port**

In `tests/provider-server/server.ts`, replace the `sort total_rating_count` branch body so it returns two games — one inside the window and one well outside it:

```ts
    if (query.includes("sort total_rating_count")) {
      return json(response, [{
        id: 220123,
        name: "Fixture Popular Classic",
        slug: "fixture-popular-classic",
        summary: "The platform's most-rated fixture title.",
        platforms: [130],
        genres: [{ name: "Platform" }],
        alternative_names: [],
        // Debuted on this platform: the platform release equals the first
        // release anywhere, so the debut rule keeps it.
        first_release_date: 1704067200,
        release_dates: [{ platform: 130, y: 2024, date: 1704067200 }]
      }, {
        id: 220124,
        name: "Fixture Late Port",
        slug: "fixture-late-port",
        summary: "Ported to this platform nineteen years after release.",
        platforms: [130],
        genres: [{ name: "Strategy" }],
        alternative_names: [],
        // First released in 2005, reached this platform in 2024. Far outside
        // the 365 day window, so the shelf must not show it.
        first_release_date: 1104537600,
        release_dates: [{ platform: 130, y: 2024, date: 1704067200 }]
      }]);
    }
```

- [ ] **Step 2: Assert the late port is absent**

In `tests/e2e/setup-and-download.spec.ts`, the block after the platform click currently asserts the heading and `Fixture Popular Classic`. Add a third assertion immediately after the `Fixture Popular Classic` one, before the axe scan:

```ts
  // The debut rule must drop it: IGDB ranks it highly by global rating count,
  // but it only reached this platform nineteen years after release.
  await expect(page.getByRole("link", { name: /Fixture Late Port/ }))
    .toHaveCount(0);
```

- [ ] **Step 3: Run the e2e spec**

Run: `pnpm exec playwright test tests/e2e/setup-and-download.spec.ts`
Expected: PASS, both tests, including the axe scan taken while the shelf is on screen.

- [ ] **Step 4: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/provider-server/server.ts tests/e2e/setup-and-download.spec.ts
git commit -m "test(e2e): assert the debut rule drops a late port"
```

---

### Task 5: Deploy and validate against live IGDB

This task has no code. The spec treats live validation as a gate on the window
constant, because no fixture can tell you whether 365 days is the right number.

**Files:** none.

- [ ] **Step 1: Publish the image**

```bash
git push origin fix/e2e-fixture-db-race
gh workflow run publish.yml --ref fix/e2e-fixture-db-race
gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

- [ ] **Step 2: Deploy**

Replace `<sha>` with the new short sha. The current pin is on line 1920 of the
host's compose file.

```bash
ssh ramsey@192.168.3.252 'docker pull ghcr.io/ramseymcgrath/gamarr:sha-<sha>'
ssh ramsey@192.168.3.252 'cp -p /app/compose/compose.yml /app/compose/compose.yml.bak-pre-<sha> && sed -i "s|ghcr.io/ramseymcgrath/gamarr:sha-[a-f0-9]*|ghcr.io/ramseymcgrath/gamarr:sha-<sha>|" /app/compose/compose.yml'
ssh ramsey@192.168.3.252 'cd /app/compose && docker compose up -d gamarr'
```

No database backup is needed: this feature adds no migration.

- [ ] **Step 3: Clear the stale cache**

The four cached platforms still hold rows ranked the old way and would serve
them for up to seven days. The table is disposable by design.

The image has no `sqlite3` binary, but the runner stage ships `better-sqlite3`
for the migrator, so node can do it. Feed the script over stdin rather than
`node -e` — nesting quotes through `ssh` then `docker exec` then `-e` is how
this goes wrong silently:

```bash
ssh ramsey@192.168.3.252 'docker exec -i gamarr node' <<'EOF'
const Database = require("better-sqlite3");
const db = new Database("/config/gamarr.db");
console.log(db.prepare("DELETE FROM platform_popular_games").run());
EOF
```

Expected output: `{ changes: 4, lastInsertRowid: 0 }` — one row per cached
platform. A `changes` of 0 means the cache was already empty, which is fine;
an error mentioning `no such table` means the deploy did not take.

- [ ] **Step 4: Record the evidence**

The container is reachable from the host at `172.28.0.25:5001`; macvlan blocks
the vlan IP from the host, and the LAN cannot reach port 5001 directly.

Run `curl` on the host over ssh and pipe the JSON to a local `python3` — that
keeps all the quoting on one side of the connection.

Survivor count per platform (8 = PS2, 7 = PS1, 6 = PC, 130 = Switch):

```bash
for p in 8 7 6 130; do
  printf 'platform %s: ' "$p"
  ssh ramsey@192.168.3.252 "curl -s -m 60 'http://172.28.0.25:5001/api/catalog/popular?platformId=$p'" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "titles")'
done
```

The full PS2 list:

```bash
ssh ramsey@192.168.3.252 "curl -s -m 60 'http://172.28.0.25:5001/api/catalog/popular?platformId=8'" \
  | python3 -c '
import json, sys
games = json.load(sys.stdin)
print(len(games), "titles")
for i, g in enumerate(games, 1):
    print(f"{i:3}. {g[\"name\"]}  ({g[\"releaseYear\"] or \"----\"})")
'
```

Check that list against the spec's acceptance criteria:

- Mafia and Age of Empires II are **absent**
- Resident Evil 4 is **present**, despite having no PS2 release date
- the shelf now reaches Jak & Daxter, Ratchet & Clank, Gran Turismo,
  Devil May Cry, Okami and Burnout 3
- record the survivor count per platform. A dense platform returning exactly
  100 survivors means the fetch ceiling is binding and real titles are being
  cut off — that is the signal to raise `POPULAR_FETCH_LIMIT`.

- [ ] **Step 5: Report the counts and the PS2 list back before considering the window settled**

---

## Task Dependency Order

Tasks 1 and 2 are independent of each other. Task 3 requires both. Tasks 4 and 5
follow in order.

```
1 ─┐
   ├─> 3 ─> 4 ─> 5
2 ─┘
```

Task 2 modifies `src/features/catalog/service.test.ts` (the provider fake) and
Task 3 modifies it again (new tests). Run them in order rather than in parallel
to avoid a conflict in that file.
