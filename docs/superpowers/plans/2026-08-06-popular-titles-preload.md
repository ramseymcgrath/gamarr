# Popular Titles Preload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a platform on `/discover` immediately shows a shelf of that platform's 24 most popular IGDB titles, cached in SQLite for seven days and served stale-while-revalidate.

**Architecture:** A new `platform_popular_games` table caches a ranked JSON array of game ids per platform. `CatalogService.popular()` reads it, serving fresh hits directly, stale hits immediately while firing a deduplicated background refresh, and misses by awaiting a refresh. The refresh calls a new `IgdbPort.popularGames` (`/games` sorted by `total_rating_count desc`) and writes through both `games` and the cache table. A new GET route feeds a shelf rendered by `DiscoverScreen`.

**Tech Stack:** Next.js App Router (`runtime = "nodejs"`), better-sqlite3 + Drizzle, zod, vitest (+ jsdom for components), Playwright + @axe-core/playwright, igdb-api-node.

**Spec:** `docs/superpowers/specs/2026-08-06-popular-titles-preload-design.md`

## Global Constraints

- Node 24 and pnpm (`corepack enable`). Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`.
- **Migrations in `drizzle/` are immutable once committed.** Never edit an existing migration; always `pnpm db:generate` a new one.
- **better-sqlite3 is synchronous. A transaction must never contain an `await`.** Do all network I/O outside the transaction.
- Features reach the outside world only through ports in `ports.ts`. Only `dependencies.ts` binds a port to a concrete adapter. Features never import integration clients.
- Throw `AppError` (or `validationError` / `forbiddenError` from `@/lib/errors`); let `errorResponse()` serialize. Never let a raw upstream message reach a response.
- No secrets, URLs, or API keys in responses, client state, or error text.
- Apicalypse platform filtering uses `platforms = (id)` — array **inclusion**. Never `platforms = {id}`, which is exact-array-match and hides multiplatform games.
- Tests colocate next to source as `*.test.ts` / `*.test.tsx`. Component tests need a first-line `/** @vitest-environment jsdom */` docblock. `clearMocks`/`restoreMocks` are global — do not hand-roll spy teardown.
- Path aliases: `@/*` → `src/*`, `@tests/*` → `tests/*`.
- Accessibility is WCAG 2.2 AA, asserted by axe in e2e. Meaning is never encoded in color alone.
- Prefer hand-written fakes implementing a port over module mocking.

## File Structure

**Create:**
- `src/features/catalog/refresh-coordinator.ts` — in-flight deduplication for background refreshes. One responsibility, no dependencies.
- `src/features/catalog/refresh-coordinator.test.ts`
- `src/features/catalog/game-card.tsx` — the game card markup, extracted so the search grid and the popular grid share it instead of duplicating ~20 lines of JSX.
- `src/app/api/catalog/popular/route.ts` — thin route shim.
- `drizzle/0005_*.sql` — generated, never hand-written.

**Modify:**
- `src/db/schema.ts` — add `platformPopularGames`.
- `src/features/catalog/ports.ts` — add `PopularGamesCache`, two `CatalogRepository` methods, one `IgdbPort` method.
- `src/features/catalog/repository.ts` — implement the two cache methods; extract the row→model mapper shared with `getGame`.
- `src/features/catalog/service.ts` — add `popular()` and the private refresh.
- `src/features/catalog/discover-screen.tsx` — popular shelf state, effect, and render.
- `src/integrations/igdb/client.ts` — `IgdbRequest.sort`, executor support, `popularGames`, shared field list and mapper.
- `src/app/api/catalog/handlers.ts` — `handleCatalogPopular` + interface method.
- `src/app/api/catalog/dependencies.ts` — module-scoped coordinator injection.
- `src/app/globals.css` — one class for the shelf note.
- `tests/provider-server/server.ts` — branch `/games` on search-vs-sort.
- `tests/e2e/setup-and-download.spec.ts` — assert the shelf.
- Existing test files whose fakes must grow the new port methods.

---

### Task 1: Cache table and repository

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/features/catalog/ports.ts`
- Modify: `src/features/catalog/repository.ts`
- Create: `drizzle/0005_*.sql` (generated)
- Test: `src/features/catalog/repository.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/features/catalog/ports.ts
  export interface PopularGamesCache {
    games: GameSearchResult[];
    fetchedAt: number;
  }
  // added to CatalogRepository
  getPopular(platformId: number): PopularGamesCache | null;
  replacePopular(platformId: number, gameIds: number[], now: number): void;
  ```
  `getPopular` returns `null` when no row has ever been written, and `{ games: [], fetchedAt }` when IGDB was asked and returned nothing. Task 4 depends on that distinction.

- [ ] **Step 1: Add the table to the schema**

In `src/db/schema.ts`, after the `platformSettings` declaration:

```ts
export const platformPopularGames = sqliteTable("platform_popular_games", {
  platformId: integer("platform_id")
    .primaryKey()
    .references(() => platforms.id, { onDelete: "cascade" }),
  gameIds: jsonText<number[]>("game_ids").notNull().default([]),
  fetchedAt: integer("fetched_at").notNull()
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0005_<name>.sql` containing `CREATE TABLE \`platform_popular_games\``, plus an appended entry in `drizzle/meta/_journal.json`. Do not edit either by hand.

- [ ] **Step 3: Add the port methods**

In `src/features/catalog/ports.ts`, add the `PopularGamesCache` interface shown above and these two lines to `CatalogRepository`:

```ts
  getPopular(platformId: number): PopularGamesCache | null;
  replacePopular(platformId: number, gameIds: number[], now: number): void;
```

- [ ] **Step 4: Write the failing tests**

Append to `src/features/catalog/repository.test.ts`. Note `platform_popular_games.platform_id` has a foreign key to `platforms` and `foreign_keys=ON`, so every test must `upsertPlatforms` first or the insert throws.

```ts
  it("round-trips a popular list in rank order", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);
    catalog.upsertGames([
      { id: 1, name: "First", slug: "first", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] },
      { id: 2, name: "Second", slug: "second", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] },
      { id: 3, name: "Third", slug: "third", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] }
    ], 100);

    catalog.replacePopular(130, [3, 1, 2], 500);

    expect(catalog.getPopular(130)).toEqual({
      fetchedAt: 500,
      games: [
        expect.objectContaining({ id: 3 }),
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 })
      ]
    });
    database.$client.close();
  });

  it("distinguishes an empty popular list from one never fetched", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);

    expect(catalog.getPopular(130)).toBeNull();

    catalog.replacePopular(130, [], 500);

    expect(catalog.getPopular(130)).toEqual({ fetchedAt: 500, games: [] });
    database.$client.close();
  });

  it("drops popular ids that are no longer cached games", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);
    catalog.upsertGames([{
      id: 1, name: "First", slug: "first", summary: null, coverUrl: null,
      releaseYear: null, genres: [], alternativeNames: [], platformIds: [130]
    }], 100);

    catalog.replacePopular(130, [99, 1], 500);

    expect(catalog.getPopular(130)?.games).toEqual([
      expect.objectContaining({ id: 1 })
    ]);
    database.$client.close();
  });

  it("replaces a popular list rather than appending to it", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);
    catalog.upsertGames([
      { id: 1, name: "First", slug: "first", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] },
      { id: 2, name: "Second", slug: "second", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] }
    ], 100);

    catalog.replacePopular(130, [1, 2], 500);
    catalog.replacePopular(130, [2], 900);

    expect(catalog.getPopular(130)).toEqual({
      fetchedAt: 900,
      games: [expect.objectContaining({ id: 2 })]
    });
    database.$client.close();
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm test src/features/catalog/repository.test.ts`
Expected: FAIL — `catalog.replacePopular is not a function`.

- [ ] **Step 6: Implement the repository methods**

In `src/features/catalog/repository.ts`, widen the drizzle import to `import { asc, eq, inArray } from "drizzle-orm";` and the schema import to include `platformPopularGames`. Add `PopularGamesCache` to the type import from `@/features/catalog/ports`.

Extract the row mapper so `getGame` and `getPopular` share it — replace the body of `getGame` and add the private helper:

```ts
  getGame(id: number): GameSearchResult | null {
    const row = this.database
      .select()
      .from(games)
      .where(eq(games.id, id))
      .get();
    return row ? SqliteCatalogRepository.toGame(row) : null;
  }

  getPopular(platformId: number): PopularGamesCache | null {
    const row = this.database
      .select()
      .from(platformPopularGames)
      .where(eq(platformPopularGames.platformId, platformId))
      .get();
    if (!row) return null;
    if (row.gameIds.length === 0) {
      return { games: [], fetchedAt: row.fetchedAt };
    }
    const cached = new Map(
      this.database
        .select()
        .from(games)
        .where(inArray(games.id, row.gameIds))
        .all()
        .map((game) => [game.id, SqliteCatalogRepository.toGame(game)])
    );
    return {
      // SQLite does not preserve `IN` order, so rank is restored from the
      // stored array. Ids whose game row is gone are dropped.
      games: row.gameIds
        .map((id) => cached.get(id))
        .filter((game): game is GameSearchResult => game !== undefined),
      fetchedAt: row.fetchedAt
    };
  }

  replacePopular(platformId: number, gameIds: number[], now: number): void {
    this.database
      .insert(platformPopularGames)
      .values({ platformId, gameIds, fetchedAt: now })
      .onConflictDoUpdate({
        target: platformPopularGames.platformId,
        set: { gameIds, fetchedAt: now }
      })
      .run();
  }

  private static toGame(
    row: typeof games.$inferSelect
  ): GameSearchResult {
    return {
      id: row.id,
      name: row.title,
      slug: row.slug,
      summary: row.summary,
      coverUrl: row.coverId,
      releaseYear: row.releaseYear,
      genres: row.genres,
      alternativeNames: row.alternateTitles,
      platformIds: row.platformIds
    };
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test src/features/catalog/repository.test.ts`
Expected: PASS, including the pre-existing `round-trips cached games` test, which now exercises the extracted mapper.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL. **Two** test fakes implement `CatalogRepository` and both must grow the new methods:

**(a)** `MemoryCatalogRepository` in `src/features/catalog/service.test.ts` — needs a working in-memory implementation, because Task 4's tests exercise it:

```ts
  popular = new Map<number, { gameIds: number[]; fetchedAt: number }>();

  getPopular(platformId: number) {
    const entry = this.popular.get(platformId);
    if (!entry) return null;
    return {
      fetchedAt: entry.fetchedAt,
      games: entry.gameIds
        .map((id) => this.games.get(id))
        .filter((game): game is GameSearchResult => game !== undefined)
    };
  }

  replacePopular(platformId: number, gameIds: number[], now: number) {
    this.popular.set(platformId, { gameIds, fetchedAt: now });
  }
```

**(b)** The `catalog` object literal at `src/features/release-search/service.test.ts:37` — release search never reads the popular cache, so inert stubs are correct here. Add to that literal:

```ts
  getPopular: () => null,
  replacePopular: () => undefined,
```

Re-run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/features/catalog/ports.ts src/features/catalog/repository.ts src/features/catalog/repository.test.ts src/features/catalog/service.test.ts src/features/release-search/service.test.ts drizzle/
git commit -m "feat(catalog): cache a ranked popular-games list per platform"
```

---

### Task 2: IGDB sort support and popularGames

**Files:**
- Modify: `src/integrations/igdb/client.ts`
- Modify: `src/features/catalog/ports.ts`
- Test: `src/integrations/igdb/client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // src/integrations/igdb/client.ts
  export interface IgdbRequest {
    endpoint: "/platforms" | "/games";
    fields: string[];
    search?: string;
    where?: string;
    sort?: { field: string; direction: "asc" | "desc" };
    limit: number;
    offset: number;
  }
  // added to IgdbPort in src/features/catalog/ports.ts
  popularGames(platformId: number, limit: number): Promise<GameSearchResult[]>;
  ```
  Sort is structured rather than a raw string because igdb-api-node's builder takes two arguments: `.sort('name', 'desc')`.

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/igdb/client.test.ts`:

```ts
  it("ranks popular games by rating count without a relevance search", async () => {
    const requests: IgdbRequest[] = [];
    const executor: IgdbExecutor = {
      execute: async (_token, request) => {
        requests.push(request);
        return [];
      }
    };

    await new IgdbClient(new FixedToken(), executor).popularGames(8, 24);

    expect(requests[0]!.sort).toEqual({
      field: "total_rating_count",
      direction: "desc"
    });
    // IGDB `search` imposes its own relevance ordering and cannot be
    // combined with an explicit sort.
    expect(requests[0]!.search).toBeUndefined();
    expect(requests[0]!.where).toBe(
      "platforms = (8) & total_rating_count != null"
    );
    expect(requests[0]!.where).not.toContain("{");
    expect(requests[0]!.limit).toBe(24);
  });

  it("maps popular games with the same shape as search results", async () => {
    const executor: IgdbExecutor = {
      execute: async () => [{
        id: 7346,
        name: "Metroid Prime 4: Beyond",
        slug: "metroid-prime-4-beyond",
        platforms: [130],
        genres: [{ name: "Adventure" }],
        alternative_names: [{ name: "Metroid Prime 4" }],
        release_dates: [{ platform: 130, y: 2025 }],
        cover: { image_id: "co123" }
      }]
    };

    const games = await new IgdbClient(new FixedToken(), executor)
      .popularGames(130, 24);

    expect(games).toEqual([
      expect.objectContaining({
        id: 7346,
        name: "Metroid Prime 4: Beyond",
        platformIds: [130],
        genres: ["Adventure"],
        alternativeNames: ["Metroid Prime 4"],
        releaseYear: 2025,
        coverUrl:
          "https://images.igdb.com/igdb/image/upload/t_cover_big/co123.jpg"
      })
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/integrations/igdb/client.test.ts`
Expected: FAIL — `client.popularGames is not a function`.

- [ ] **Step 3: Add sort to the request type and executor**

In `src/integrations/igdb/client.ts`, add to `IgdbRequest` after `where`:

```ts
  sort?: { field: string; direction: "asc" | "desc" };
```

and in `SdkIgdbExecutor.execute`, immediately after the `if (request.where)` line:

```ts
    if (request.sort) {
      query = query.sort(request.sort.field, request.sort.direction);
    }
```

- [ ] **Step 4: Extract the shared field list and mapper**

Still in `src/integrations/igdb/client.ts`, add module-level constants after `gameSchema`:

```ts
const GAME_FIELDS = [
  "id",
  "name",
  "slug",
  "summary",
  "platforms",
  "genres.name",
  "alternative_names.name",
  "release_dates.platform",
  "release_dates.y",
  "cover.image_id"
];

function toGameSearchResult(
  game: z.infer<typeof gameSchema>,
  platformId: number
): GameSearchResult {
  return {
    id: game.id,
    name: game.name,
    slug: game.slug,
    summary: game.summary ?? null,
    coverUrl: game.cover
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
      : null,
    releaseYear: game.release_dates
      .find((date) => date.platform === platformId && date.y)?.y ?? null,
    genres: game.genres.map((genre) => genre.name),
    alternativeNames: game.alternative_names.map((name) => name.name),
    platformIds: game.platforms
  };
}
```

Then rewrite `searchGames` to use them, preserving the existing `where` comment verbatim:

```ts
  async searchGames(
    query: string,
    platformId: number
  ): Promise<GameSearchResult[]> {
    const games = z.array(gameSchema).parse(await this.execute({
      endpoint: "/games",
      fields: GAME_FIELDS,
      search: query,
      // `(...)` is array inclusion ("contains any of"), which is what
      // "available on this platform" means. NOT `{...}`, which is Apicalypse's
      // *exact array match*: `platforms = {8}` is IGDB's own documented idiom
      // for "PlayStation 2 exclusives", so it silently hid every multiplatform
      // game — Grand Theft Auto III, Burnout 3 and Jak II all returned zero
      // hits for PS2 while PS2-only fan mods ranked fine.
      where: `platforms = (${platformId})`,
      limit: 24,
      offset: 0
    }));

    return games.map((game) => toGameSearchResult(game, platformId));
  }
```

- [ ] **Step 5: Implement popularGames**

Add to `IgdbClient`, directly after `searchGames`:

```ts
  async popularGames(
    platformId: number,
    limit: number
  ): Promise<GameSearchResult[]> {
    const games = z.array(gameSchema).parse(await this.execute({
      endpoint: "/games",
      fields: GAME_FIELDS,
      // Same membership idiom as searchGames — never `{...}`. Rows with no
      // rating count at all would otherwise sort ahead of nothing and pad the
      // shelf with unranked entries.
      where: `platforms = (${platformId}) & total_rating_count != null`,
      // `follows` is deprecated on /games and `hypes` only counts pre-release
      // interest, so rating count is the durable popularity signal here.
      sort: { field: "total_rating_count", direction: "desc" },
      limit,
      offset: 0
    }));

    return games.map((game) => toGameSearchResult(game, platformId));
  }
```

- [ ] **Step 6: Add the port method**

In `src/features/catalog/ports.ts`, add to `IgdbPort`:

```ts
  popularGames(platformId: number, limit: number): Promise<GameSearchResult[]>;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test src/integrations/igdb/client.test.ts`
Expected: PASS, all seven tests.

- [ ] **Step 8: Typecheck and fix the service test fake**

Run: `pnpm typecheck`
Expected: FAIL — the `provider` object literal in `src/features/catalog/service.test.ts` no longer satisfies `IgdbPort`. Add to it, after `searchGames`:

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
      platformIds: [130]
    }
  ]
```

Re-run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/integrations/igdb/client.ts src/integrations/igdb/client.test.ts src/features/catalog/ports.ts src/features/catalog/service.test.ts
git commit -m "feat(igdb): add sorted queries and a platform popular-games fetch"
```

---

### Task 3: Refresh coordinator

**Files:**
- Create: `src/features/catalog/refresh-coordinator.ts`
- Test: `src/features/catalog/refresh-coordinator.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RefreshCoordinator {
    run(key: number, task: () => Promise<void>): Promise<void>;
  }
  export class InFlightRefreshCoordinator implements RefreshCoordinator {}
  ```
  `run` returns the in-flight promise when one exists for that key, otherwise starts the task, stores it, and clears the entry once it settles. Rejections propagate to every caller; callers that do not want them must attach `.catch()`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/catalog/refresh-coordinator.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { InFlightRefreshCoordinator } from "@/features/catalog/refresh-coordinator";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

describe("InFlightRefreshCoordinator", () => {
  it("runs one task for concurrent callers sharing a key", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    const gate = deferred();
    let runs = 0;

    const first = coordinator.run(130, () => {
      runs += 1;
      return gate.promise;
    });
    const second = coordinator.run(130, () => {
      runs += 1;
      return gate.promise;
    });

    gate.resolve();
    await Promise.all([first, second]);

    expect(runs).toBe(1);
  });

  it("runs tasks for different keys independently", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    const keys: number[] = [];

    await Promise.all([
      coordinator.run(130, async () => {
        keys.push(130);
      }),
      coordinator.run(8, async () => {
        keys.push(8);
      })
    ]);

    expect(keys.sort()).toEqual([8, 130]);
  });

  it("allows a new run once the previous one settles", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    let runs = 0;
    const task = async () => {
      runs += 1;
    };

    await coordinator.run(130, task);
    await coordinator.run(130, task);

    expect(runs).toBe(2);
  });

  it("propagates a rejection to every caller and clears the key", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    const gate = deferred();
    const first = coordinator.run(130, () => gate.promise);
    const second = coordinator.run(130, () => gate.promise);

    gate.reject(new Error("upstream down"));

    await expect(first).rejects.toThrow("upstream down");
    await expect(second).rejects.toThrow("upstream down");
    // A failed refresh must not poison the key forever.
    await expect(coordinator.run(130, async () => undefined)).resolves
      .toBeUndefined();
  });

  it("clears the key when the task throws synchronously", async () => {
    const coordinator = new InFlightRefreshCoordinator();

    await expect(coordinator.run(130, () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await expect(coordinator.run(130, async () => undefined)).resolves
      .toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/features/catalog/refresh-coordinator.test.ts`
Expected: FAIL — cannot resolve `@/features/catalog/refresh-coordinator`.

- [ ] **Step 3: Implement the coordinator**

Create `src/features/catalog/refresh-coordinator.ts`:

```ts
/**
 * Deduplicates background refreshes by key.
 *
 * `catalogService()` builds a fresh `CatalogService` per request, so a guard
 * held on the service instance would be a new empty map every time and would
 * never dedupe. This is injected from `dependencies.ts` as a module-scoped
 * singleton, the same way `IgdbRequestGate` is.
 */
export interface RefreshCoordinator {
  run(key: number, task: () => Promise<void>): Promise<void>;
}

export class InFlightRefreshCoordinator implements RefreshCoordinator {
  private readonly inFlight = new Map<number, Promise<void>>();

  run(key: number, task: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    // `Promise.resolve().then(task)` so a synchronous throw inside `task`
    // still produces a rejected promise, and the `finally` still clears
    // the key rather than wedging it forever.
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/features/catalog/refresh-coordinator.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/catalog/refresh-coordinator.ts src/features/catalog/refresh-coordinator.test.ts
git commit -m "feat(catalog): add an in-flight refresh coordinator"
```

---

### Task 4: Service popular() with stale-while-revalidate

**Files:**
- Modify: `src/features/catalog/service.ts`
- Test: `src/features/catalog/service.test.ts`

**Interfaces:**
- Consumes: `CatalogRepository.getPopular` / `replacePopular` and `PopularGamesCache` (Task 1); `IgdbPort.popularGames` (Task 2); `RefreshCoordinator` and `InFlightRefreshCoordinator` (Task 3).
- Produces:
  ```ts
  // CatalogService
  constructor(
    repository: CatalogRepository,
    provider: IgdbPort | (() => IgdbPort),
    now?: () => number,
    coordinator?: RefreshCoordinator
  )
  async popular(platformId: number): Promise<GameSearchResult[]>
  ```
  `coordinator` defaults to a fresh per-instance `InFlightRefreshCoordinator`. Task 5 must inject a module-scoped one from `dependencies.ts` or deduplication is silently lost in production.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/catalog/service.test.ts`. Add the import `import { InFlightRefreshCoordinator } from "@/features/catalog/refresh-coordinator";` and this helper above the `describe`:

```ts
const WEEK = 7 * 24 * 60 * 60 * 1000;

function visiblePlatform(repository: MemoryCatalogRepository) {
  repository.platforms.set(130, {
    id: 130,
    name: "Nintendo Switch",
    abbreviation: "Switch",
    visible: true,
    aliases: []
  });
}

function countingProvider(games = provider.popularGames) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    port: {
      ...provider,
      popularGames: async (platformId: number, limit: number) => {
        calls += 1;
        return games(platformId, limit);
      }
    } satisfies IgdbPort
  };
}
```

Then the tests:

```ts
  it("requires a visible platform before listing popular games", async () => {
    const repository = new MemoryCatalogRepository();
    repository.platforms.set(130, {
      id: 130,
      name: "Nintendo Switch",
      abbreviation: "Switch",
      visible: false,
      aliases: []
    });
    const service = new CatalogService(repository, provider);

    await expect(service.popular(130)).rejects.toBeInstanceOf(AppError);
    await expect(service.popular(999)).rejects.toBeInstanceOf(AppError);
  });

  it("fetches, caches and upserts popular games on a cold platform", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const counting = countingProvider();
    const service = new CatalogService(repository, counting.port, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 7346 })
    ]);

    expect(counting.calls).toBe(1);
    // The detail page reads games from the local table, so a popular card
    // whose game was never upserted would be a dead link.
    expect(repository.getGame(7346)).toMatchObject({ id: 7346 });
    expect(repository.popular.get(130)).toEqual({
      gameIds: [7346],
      fetchedAt: 1_000
    });
  });

  it("serves a fresh cache without calling the provider", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const counting = countingProvider();
    const service = new CatalogService(repository, counting.port, () => 1_000);

    await service.popular(130);
    await service.popular(130);

    expect(counting.calls).toBe(1);
  });

  it("drops popular games that are not on the requested platform", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => [{
        id: 42,
        name: "Wrong platform",
        slug: "wrong-platform",
        summary: null,
        coverUrl: null,
        releaseYear: null,
        genres: [],
        alternativeNames: [],
        platformIds: [8]
      }]
    }, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([]);
  });

  it("serves a stale cache immediately and refreshes once behind it", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    repository.games.set(1, {
      id: 1, name: "Stale", slug: "stale", summary: null, coverUrl: null,
      releaseYear: null, genres: [], alternativeNames: [], platformIds: [130]
    });
    repository.popular.set(130, { gameIds: [1], fetchedAt: 0 });

    const counting = countingProvider();
    const refreshes: Promise<void>[] = [];
    const inner = new InFlightRefreshCoordinator();
    const service = new CatalogService(
      repository,
      counting.port,
      () => WEEK + 1,
      {
        run: (key, task) => {
          const promise = inner.run(key, task);
          refreshes.push(promise);
          return promise;
        }
      }
    );

    const [first, second] = await Promise.all([
      service.popular(130),
      service.popular(130)
    ]);

    expect(first).toEqual([expect.objectContaining({ id: 1, name: "Stale" })]);
    expect(second).toEqual(first);

    await Promise.allSettled(refreshes);

    expect(counting.calls).toBe(1);
    expect(repository.popular.get(130)).toEqual({
      gameIds: [7346],
      fetchedAt: WEEK + 1
    });
  });

  it("keeps serving a stale cache when the refresh fails", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    repository.games.set(1, {
      id: 1, name: "Stale", slug: "stale", summary: null, coverUrl: null,
      releaseYear: null, genres: [], alternativeNames: [], platformIds: [130]
    });
    repository.popular.set(130, { gameIds: [1], fetchedAt: 0 });

    const refreshes: Promise<void>[] = [];
    const inner = new InFlightRefreshCoordinator();
    const service = new CatalogService(
      repository,
      {
        ...provider,
        popularGames: async () => {
          throw new AppError("UNAVAILABLE", 502, "IGDB request failed");
        }
      },
      () => WEEK + 1,
      {
        run: (key, task) => {
          const promise = inner.run(key, task);
          refreshes.push(promise);
          return promise;
        }
      }
    );

    await expect(service.popular(130)).resolves.toEqual([
      expect.objectContaining({ id: 1 })
    ]);

    // Settled, not awaited bare: the service swallows this rejection so a
    // background failure never becomes an unhandled rejection.
    const [outcome] = await Promise.allSettled(refreshes);
    expect(outcome!.status).toBe("rejected");
    expect(repository.popular.get(130)).toEqual({ gameIds: [1], fetchedAt: 0 });
  });

  it("propagates a provider failure when there is no cache to fall back on", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    const service = new CatalogService(repository, {
      ...provider,
      popularGames: async () => {
        throw new AppError("UNAVAILABLE", 502, "IGDB request failed");
      }
    }, () => 1_000);

    await expect(service.popular(130)).rejects.toMatchObject({ status: 502 });
  });

  it("serves an empty cached list without re-asking the provider", async () => {
    const repository = new MemoryCatalogRepository();
    visiblePlatform(repository);
    repository.popular.set(130, { gameIds: [], fetchedAt: 1_000 });
    const counting = countingProvider();
    const service = new CatalogService(repository, counting.port, () => 1_000);

    await expect(service.popular(130)).resolves.toEqual([]);
    expect(counting.calls).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/features/catalog/service.test.ts`
Expected: FAIL — `service.popular is not a function`.

- [ ] **Step 3: Implement popular()**

In `src/features/catalog/service.ts`, add the import:

```ts
import {
  InFlightRefreshCoordinator,
  type RefreshCoordinator
} from "@/features/catalog/refresh-coordinator";
```

Add module constants above the class:

```ts
const POPULAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POPULAR_LIMIT = 24;
```

Extend the constructor with a fourth parameter:

```ts
  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: IgdbPort | (() => IgdbPort),
    private readonly now: () => number = Date.now,
    private readonly coordinator: RefreshCoordinator =
      new InFlightRefreshCoordinator()
  ) {}
```

Add the two methods after `search`:

```ts
  async popular(platformId: number): Promise<GameSearchResult[]> {
    const platform = this.repository.getPlatform(platformId);
    if (!platform?.visible) {
      throw validationError("Select a visible platform before searching");
    }

    const cached = this.repository.getPopular(platformId);
    if (cached) {
      if (this.now() - cached.fetchedAt < POPULAR_TTL_MS) return cached.games;
      // Stale: serve what we have and refresh behind it. The rejection is
      // dropped deliberately — the caller already has a usable list, and an
      // unhandled rejection here would surface in the server logs as a crash.
      this.coordinator
        .run(platformId, () => this.refreshPopular(platformId))
        .catch(() => undefined);
      return cached.games;
    }

    // Cold: nothing to show, so a provider failure must reach the caller.
    await this.coordinator.run(
      platformId,
      () => this.refreshPopular(platformId)
    );
    return this.repository.getPopular(platformId)?.games ?? [];
  }

  private async refreshPopular(platformId: number): Promise<void> {
    const games = (
      await this.getProvider().popularGames(platformId, POPULAR_LIMIT)
    ).filter((game) => game.platformIds.includes(platformId));
    // Everything past this point is synchronous better-sqlite3 work; the only
    // await in this method is the network call above.
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
Expected: PASS, all eleven tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/catalog/service.ts src/features/catalog/service.test.ts
git commit -m "feat(catalog): serve popular games stale-while-revalidate on a 7-day TTL"
```

---

### Task 5: HTTP handler, route and wiring

**Files:**
- Modify: `src/app/api/catalog/handlers.ts`
- Create: `src/app/api/catalog/popular/route.ts`
- Modify: `src/app/api/catalog/dependencies.ts`
- Test: `src/app/api/catalog/handlers.test.ts`

**Interfaces:**
- Consumes: `CatalogService.popular` (Task 4), `InFlightRefreshCoordinator` (Task 3).
- Produces: `GET /api/catalog/popular?platformId=<n>` returning `GameSearchResult[]` with `cache-control: no-store`, and
  ```ts
  export async function handleCatalogPopular(
    request: Request,
    dependencies: { service: CatalogHandlerService }
  ): Promise<Response>
  ```
  Task 6 calls this endpoint from the browser.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/catalog/handlers.test.ts`, add `handleCatalogPopular` to the import list, add `popular` to the `service` fake:

```ts
  popular: async (platformId: number) => [
    { id: 2, name: "Popular", platformIds: [platformId] }
  ],
```

and append these tests:

```ts
  it("returns the popular list for a platform", async () => {
    const response = await handleCatalogPopular(
      new Request("http://gamarr.local/api/catalog/popular?platformId=130"),
      { service }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual([
      { id: 2, name: "Popular", platformIds: [130] }
    ]);
  });

  it("rejects a popular request without a usable platform", async () => {
    for (const search of ["", "?platformId=0", "?platformId=abc", "?platformId=1.5"]) {
      const response = await handleCatalogPopular(
        new Request(`http://gamarr.local/api/catalog/popular${search}`),
        { service }
      );
      expect(response.status).toBe(400);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/app/api/catalog/handlers.test.ts`
Expected: FAIL — `handleCatalogPopular` is not exported.

- [ ] **Step 3: Implement the handler**

In `src/app/api/catalog/handlers.ts`, add to `CatalogHandlerService`:

```ts
  popular(platformId: number): Promise<unknown>;
```

and add after `handleCatalogSearch`:

```ts
export async function handleCatalogPopular(
  request: Request,
  dependencies: { service: CatalogHandlerService }
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const platformId = Number(url.searchParams.get("platformId"));
    if (!Number.isInteger(platformId) || platformId <= 0) {
      throw validationError("platformId must be a positive integer");
    }
    return Response.json(
      await dependencies.service.popular(platformId),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
```

No `assertTrustedMutation`: this is a GET, consistent with `handleCatalogSearch`, which likewise writes through to `games` on a GET.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/app/api/catalog/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route shim**

Create `src/app/api/catalog/popular/route.ts`:

```ts
import { catalogService } from "@/app/api/catalog/dependencies";
import { handleCatalogPopular } from "@/app/api/catalog/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleCatalogPopular(request, { service: catalogService() });
}
```

- [ ] **Step 6: Inject the shared coordinator**

In `src/app/api/catalog/dependencies.ts`, add the import:

```ts
import { InFlightRefreshCoordinator } from "@/features/catalog/refresh-coordinator";
```

add a module-scoped singleton next to `const gate = new IgdbRequestGate();`:

```ts
// Module-scoped for the same reason `gate` is: `catalogService()` builds a new
// service per request, so a per-instance coordinator would never dedupe.
const popularRefreshes = new InFlightRefreshCoordinator();
```

and pass it through:

```ts
export function catalogService(): CatalogService {
  return new CatalogService(
    new SqliteCatalogRepository(getDatabase()),
    igdbClient,
    Date.now,
    popularRefreshes
  );
}
```

- [ ] **Step 7: Verify the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/catalog/handlers.ts src/app/api/catalog/handlers.test.ts src/app/api/catalog/popular/route.ts src/app/api/catalog/dependencies.ts
git commit -m "feat(api): expose platform popular games over GET /api/catalog/popular"
```

---

### Task 6: Discover shelf

**Files:**
- Create: `src/features/catalog/game-card.tsx`
- Modify: `src/features/catalog/discover-screen.tsx`
- Modify: `src/app/globals.css`
- Test: `src/features/catalog/discover-screen.test.tsx`

**Interfaces:**
- Consumes: `GET /api/catalog/popular?platformId=<n>` (Task 5).
- Produces:
  ```tsx
  export function GameCard({ game, href }: {
    game: GameSearchResult;
    href: string;
  }): JSX.Element
  ```
  Task 7 asserts against the rendered shelf heading `Popular on <platform name>`.

- [ ] **Step 1: Write the failing tests**

Replace `src/features/catalog/discover-screen.test.tsx` with:

```tsx
/** @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoverScreen } from "@/features/catalog/discover-screen";

const platforms = [{
  id: 130,
  name: "Nintendo Switch",
  abbreviation: "Switch",
  visible: true,
  aliases: ["switch"],
  categoryIds: [],
  lastSyncedAt: 1
}];

const popularGame = {
  id: 7346,
  name: "Metroid Prime 4: Beyond",
  slug: "metroid-prime-4-beyond",
  summary: null,
  coverUrl: null,
  releaseYear: 2025,
  genres: [],
  alternativeNames: [],
  platformIds: [130]
};

const searchGame = { ...popularGame, id: 999, name: "Searched Title" };

function stubFetch(
  handler: (url: string) => unknown = (url) =>
    url.includes("/popular") ? [popularGame] : [searchGame]
) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => handler(String(input))
  })));
}

beforeEach(() => {
  stubFetch();
});

// `restoreMocks` only restores spies. `vitest.config.ts` does not set
// `unstubGlobals`, so without this the fetch stub leaks into every later
// test file in the run.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DiscoverScreen", () => {
  it("requires a platform before searching the catalog", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.type(screen.getByRole("searchbox"), "Metroid");

    expect(screen.getByRole("button", { name: "Search games" })).toBeDisabled();
  });

  it("shows popular titles once a platform is chosen", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    expect(screen.queryByRole("heading", { name: /Popular on/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));

    expect(await screen.findByRole("heading", {
      name: "Popular on Nintendo Switch"
    })).toBeVisible();
    expect(screen.getByRole("link", { name: /Metroid Prime 4: Beyond/ }))
      .toBeVisible();
  });

  it("keeps the popular shelf out of the results live region", async () => {
    const user = userEvent.setup();
    const { container } = render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));
    await screen.findByRole("heading", { name: "Popular on Nintendo Switch" });

    // 24 cards announced on every platform click would be unusable with a
    // screen reader, so the shelf must sit outside aria-live.
    const live = container.querySelector("[aria-live]");
    expect(live).not.toBeNull();
    expect(live!.textContent).not.toContain("Metroid Prime 4: Beyond");
  });

  it("hides the shelf after a search and restores it when the query clears", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));
    await screen.findByRole("heading", { name: "Popular on Nintendo Switch" });

    await user.type(screen.getByRole("searchbox"), "Metroid");
    await user.click(screen.getByRole("button", { name: "Search games" }));

    expect(await screen.findByRole("link", { name: /Searched Title/ }))
      .toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /Popular on/ })).toBeNull();
    });

    await user.clear(screen.getByRole("searchbox"));

    expect(await screen.findByRole("heading", {
      name: "Popular on Nintendo Switch"
    })).toBeVisible();
  });

  it("reports a failed popular fetch without breaking search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({})
    })));
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));

    expect(await screen.findByText("Couldn't load popular titles."))
      .toBeVisible();
    await user.type(screen.getByRole("searchbox"), "Metroid");
    expect(screen.getByRole("button", { name: "Search games" }))
      .toBeEnabled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/features/catalog/discover-screen.test.tsx`
Expected: FAIL — no `Popular on Nintendo Switch` heading is rendered.

- [ ] **Step 3: Extract the game card**

Create `src/features/catalog/game-card.tsx`:

```tsx
import { Gamepad2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";

import type { GameSearchResult } from "@/features/catalog/models";

export function GameCard({
  game,
  href
}: {
  game: GameSearchResult;
  href: string;
}) {
  return (
    <Link className="game-card" href={href as Route}>
      <div className="game-cover">
        {game.coverUrl ? (
          <Image
            src={game.coverUrl}
            alt=""
            fill
            sizes="(max-width: 720px) 45vw, 220px"
          />
        ) : (
          <Gamepad2 aria-hidden="true" />
        )}
      </div>
      <div>
        <h3>{game.name}</h3>
        <p>{game.releaseYear ?? "YEAR UNKNOWN"}</p>
      </div>
    </Link>
  );
}
```

- [ ] **Step 4: Add shelf state and the fetch effect**

In `src/features/catalog/discover-screen.tsx`, change the React import to `import { useEffect, useState, type FormEvent } from "react";` and add `import { GameCard } from "@/features/catalog/game-card";`.

After Step 6 replaces both grids with `GameCard`, three imports become unused and will fail `pnpm lint`: `Image` from `next/image`, and the `Route` type from `next` (hrefs are now plain strings that `GameCard` casts). Remove both. Keep `Link` — the empty state still uses it — and keep `Gamepad2`, still used by the platform spine buttons.

Add after the existing `useState` calls:

```tsx
  const [popular, setPopular] = useState<GameSearchResult[]>([]);
  const [popularState, setPopularState] =
    useState<"idle" | "loading" | "error">("idle");
  const platformName = visible.find(
    (platform) => platform.id === platformId
  )?.name ?? "";
  const showPopular = state === "idle" && platformId !== null && (
    popularState !== "idle" || popular.length > 0
  );

  useEffect(() => {
    if (!platformId) {
      setPopular([]);
      setPopularState("idle");
      return;
    }
    // Without this, clicking quickly between platforms lets a slow response
    // land after a fast one and render the wrong platform's shelf.
    const controller = new AbortController();
    setPopularState("loading");
    fetch(`/api/catalog/popular?platformId=${platformId}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Popular fetch failed");
        setPopular(await response.json());
        setPopularState("idle");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPopular([]);
        setPopularState("error");
      });
    return () => controller.abort();
  }, [platformId]);
```

- [ ] **Step 5: Restore the shelf when the query clears**

Still in `src/features/catalog/discover-screen.tsx`, add above the `search` function:

```tsx
  const updateQuery = (value: string) => {
    setQuery(value);
    // Emptying the box returns Discover to its browse state, so the shelf is
    // the real empty state for search rather than a one-shot splash.
    if (!value.trim()) {
      setResults([]);
      setState("idle");
    }
  };
```

and change the `Input`'s handler to `onChange={(event) => updateQuery(event.target.value)}`.

- [ ] **Step 6: Render the shelf and reuse the card**

Insert between the closing `</form>` and the `<section aria-live="polite" …>`:

```tsx
          {showPopular && (
            <section
              aria-labelledby="popular-heading"
              aria-busy={popularState === "loading"}
              className="catalog-results"
            >
              <div className="result-heading">
                <h2 id="popular-heading">Popular on {platformName}</h2>
              </div>
              {popularState === "loading" && (
                <p className="popular-note">Loading popular titles…</p>
              )}
              {popularState === "error" && (
                <p className="popular-note">Couldn&apos;t load popular titles.</p>
              )}
              {popular.length > 0 && (
                <div className="game-grid">
                  {popular.map((game) => (
                    <GameCard
                      game={game}
                      href={`/discover/${game.id}?platformId=${platformId}&q=&returnTo=${encodeURIComponent(`/discover?platformId=${platformId}`)}`}
                      key={game.id}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
```

Then replace the existing results grid body so both grids share one component:

```tsx
                <div className="game-grid">
                  {results.map((game) => (
                    <GameCard
                      game={game}
                      href={`/discover/${game.id}?platformId=${platformId}&q=${encodeURIComponent(query)}&returnTo=${encodeURIComponent(`/discover?platformId=${platformId}&q=${query}`)}`}
                      key={game.id}
                    />
                  ))}
                </div>
```

- [ ] **Step 7: Add the note style**

Append to `src/app/globals.css` after the `.catalog-results` block:

```css
.popular-note {
  margin-top: 12px;
  font-size: 0.85rem;
}
```

No color override — the note inherits body color so it cannot regress the axe contrast assertion.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test src/features/catalog/discover-screen.test.tsx`
Expected: PASS, all six tests.

- [ ] **Step 9: Verify the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/features/catalog/game-card.tsx src/features/catalog/discover-screen.tsx src/features/catalog/discover-screen.test.tsx src/app/globals.css
git commit -m "feat(discover): show popular titles when a platform is chosen"
```

---

### Task 7: End-to-end coverage

**Files:**
- Modify: `tests/provider-server/server.ts`
- Modify: `tests/e2e/setup-and-download.spec.ts`

**Interfaces:**
- Consumes: the shelf heading `Popular on Nintendo Switch` (Task 6) and the popular endpoint (Task 5).
- Produces: nothing downstream.

- [ ] **Step 1: Branch the stub on search versus sort**

In `tests/provider-server/server.ts`, replace the `/games` block:

```ts
  if (url.pathname.endsWith("/games")) {
    // igdb-api-node sends the Apicalypse query as the request body. Answering
    // every /games call with the same fixture would let the popular path pass
    // without ever proving it sent a sorted query.
    const query = (await body(request)).toString("utf8");
    if (query.includes("sort total_rating_count")) {
      return json(response, [{
        id: 220123,
        name: "Fixture Popular Classic",
        slug: "fixture-popular-classic",
        summary: "The platform's most-rated fixture title.",
        platforms: [130],
        genres: [{ name: "Platform" }],
        alternative_names: [],
        release_dates: [{ platform: 130, y: 2024 }]
      }]);
    }
    return json(response, [{
      id: 119388,
      name: "Metroid Prime 4: Beyond",
      slug: "metroid-prime-4-beyond",
      summary: "Samus Aran explores the alien world of Viewros.",
      platforms: [130],
      genres: [{ name: "Adventure" }, { name: "Shooter" }],
      alternative_names: [{ name: "Metroid Prime 4" }],
      release_dates: [{ platform: 130, y: 2026 }]
    }]);
  }
```

The popular fixture is deliberately a *different* game from the search fixture. If both were "Metroid Prime 4: Beyond", the existing `getByRole("link", { name: /Metroid Prime 4: Beyond/ })` step could match two links and fail Playwright strict mode.

- [ ] **Step 2: Assert the shelf in the main flow**

In `tests/e2e/setup-and-download.spec.ts`, after the line that clicks the platform button (`await page.getByRole("button", { name: /Nintendo Switch/ }).click();`) and before the searchbox is filled, insert:

```ts
  await expect(page.getByRole("heading", { name: "Popular on Nintendo Switch" }))
    .toBeVisible();
  await expect(page.getByRole("link", { name: /Fixture Popular Classic/ }))
    .toBeVisible();
```

- [ ] **Step 3: Run the e2e suite**

Run: `pnpm exec playwright test tests/e2e/setup-and-download.spec.ts`
Expected: PASS, including the existing axe accessibility assertion, which now covers the shelf section.

- [ ] **Step 4: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/provider-server/server.ts tests/e2e/setup-and-download.spec.ts
git commit -m "test(e2e): cover the popular titles shelf on discover"
```

---

## Task Dependency Order

Tasks 1, 2 and 3 are independent of each other and may run in parallel. Task 4 requires all three. Tasks 5, 6 and 7 are strictly sequential after that.

```
1 ─┐
2 ─┼─> 4 ─> 5 ─> 6 ─> 7
3 ─┘
```

Tasks 1 and 2 both modify `src/features/catalog/ports.ts` (Task 1 adds `CatalogRepository` methods, Task 2 adds one `IgdbPort` method) and both touch `src/features/catalog/service.test.ts` fakes. If run in parallel, expect a small merge conflict in those two files and resolve by keeping both additions.
