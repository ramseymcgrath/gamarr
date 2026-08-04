# Internet Archive Torrent Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator send a whole Internet Archive item to qBittorrent from the download dialog, tracked through the normal attempt lifecycle.

**Architecture:** Torrent delivery follows the SABnzbd-shaped path — claim the attempt, fetch bounded bytes, submit to an external client, reconcile against a durable marker — not the Internet Archive direct-download path. Gamarr never moves the payload and never becomes a BitTorrent peer. A new `TorrentClientPort` sits in `features/downloads/port.ts` with a single `src/integrations/qbittorrent/client.ts` adapter behind it.

**Tech Stack:** Next.js App Router (Node runtime only), better-sqlite3 + Drizzle, zod, vitest, Playwright, Radix UI.

**Spec:** `docs/superpowers/specs/2026-08-04-internet-archive-torrent-source-design.md` — authoritative. Read it before Task 1.

## Global Constraints

- Node 24, pnpm via corepack. Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- **Migrations in `drizzle/` are immutable once committed.** Generate new ones with `pnpm db:generate`; never edit an applied file.
- **better-sqlite3 is synchronous.** Transactions stay short and contain no `await`. Claim the row first, do network I/O outside the transaction.
- **Secrets never reach the client.** The qBittorrent password is on the same footing as an indexer API key: never in a response, an error message, a log, or a React Query key. `Public*Settings` shapes replace each secret with a boolean.
- **`failureDetail` is only ever written from an `AppError` message.** Anything else becomes a fixed generic string — a raw `undici` or client error can carry a credentialed URL.
- Throw `AppError` (or `validationError` / `forbiddenError`) from `src/lib/errors.ts`; let `errorResponse()` serialize. Non-`AppError` becomes a generic 500.
- Every mutating route calls `assertTrustedMutation(request, policy)`.
- Routes export `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
- Feature slices reach outside only through ports; `dependencies.ts` binds port to adapter. Features never import integration clients. The only exceptions are pure no-I/O policy modules (`newznab/url-policy`, `internet-archive/path-policy`).
- Tests are colocated as `*.test.ts` / `*.test.tsx`. Component tests need a first-line `/** @vitest-environment jsdom */` docblock. `clearMocks` and `restoreMocks` are global — do not hand-roll spy teardown. Prefer hand-written fakes over module mocks.
- Path aliases: `@/*` → `src/*`, `@tests/*` → `tests/*`.
- Accessibility is a requirement (WCAG 2.2 AA). Status and rank encode meaning in text *and* shape, never colour alone.
- Every response bodies is size-bounded via `read-bounded-response.ts`.
- Commit after each task with a conventional-commit subject.

---

### Task 1: Schema, migration, and attempt source widening

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/features/downloads/models.ts`
- Modify: `src/features/downloads/repository.ts`
- Create: `drizzle/0004_*.sql` (generated)
- Test: `src/features/downloads/repository.test.ts`, `src/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AttemptSourceType`, `DownloadAttempt.torrentHash: string | null`, the `qbittorrentSettings` Drizzle table.

- [ ] **Step 1: Write the failing repository test**

Add to `src/features/downloads/repository.test.ts`:

```ts
it("round-trips a torrent attempt's hash and source", () => {
  const { repository, seed } = setup(); // reuse the file's existing harness
  const attempt = seed({
    source: "internet-archive-torrent",
    torrentHash: null
  });
  const updated = repository.update(attempt.id, {
    status: "Queued",
    torrentHash: "8c212779b4abde7c6bc608063a0d008b7e40ce32"
  });
  expect(updated.source).toBe("internet-archive-torrent");
  expect(updated.torrentHash).toBe("8c212779b4abde7c6bc608063a0d008b7e40ce32");
});

it("refuses a torrent write once the attempt is terminal", () => {
  const { repository, seed } = setup();
  const attempt = seed({ source: "internet-archive-torrent" });
  repository.update(attempt.id, { status: "Completed" });
  const after = repository.update(attempt.id, { torrentHash: "deadbeef" });
  expect(after.torrentHash).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test src/features/downloads/repository.test.ts`
Expected: FAIL — `torrentHash` is not a property of the attempt.

- [ ] **Step 3: Widen the attempt source type**

In `src/features/downloads/models.ts`:

```ts
/**
 * How an attempt's payload is delivered. Wider than `ReleaseSourceType`
 * because torrent delivery is a property of the *attempt*, not of the release:
 * an Internet Archive search result can be taken either way, and the choice is
 * made at submit time. Stored on the attempt because `assertSameRequest`
 * recomputes a replayed fingerprint from it — the candidate that produced the
 * original may already have expired.
 */
export type AttemptSourceType =
  | ReleaseSourceType
  | "internet-archive-torrent";
```

Change `DownloadAttempt.source` from `ReleaseSourceType` to `AttemptSourceType`, and add after `iaFileName`:

```ts
  /** qBittorrent infohash. Null until the client reports one — WebAPI builds
   * before 2.14.0 answer `torrents/add` with a bare `Ok.`, and those attempts
   * are matched by tag instead. */
  torrentHash: string | null;
```

Add to `SubmitDownloadInput`:

```ts
  /**
   * Which delivery an Internet Archive candidate should use. Defaults to
   * `"file"` so existing clients keep working unchanged. Ignored for Newznab
   * candidates, which have only one delivery.
   */
  delivery?: "file" | "torrent";
```

- [ ] **Step 4: Add the schema changes**

In `src/db/schema.ts`, add `torrentHash: text("torrent_hash")` to `downloadAttempts` immediately after `iaFileName`. Add **no** unique index on it — the same infohash may legitimately back two library entries, and a unique index would reject the second as a duplicate.

Add the new table after `sabnzbdSettings`:

```ts
export const qbittorrentSettings = sqliteTable("qbittorrent_settings", {
  id: integer("id").primaryKey().default(1),
  baseUrl: text("base_url").notNull(),
  username: text("username").notNull(),
  password: text("password").notNull(),
  defaultCategory: text("default_category"),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: integer("last_tested_at"),
  configRevision: integer("config_revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  check("qbittorrent_singleton", sql`${table.id} = 1`)
]);
```

Leave `download_attempts.source` alone: it carries no CHECK constraint, so the third value needs no table rebuild. Leave the `release_candidates_source_valid` constraint alone — candidates stay `newznab | internet-archive`.

- [ ] **Step 5: Map the new column in the repository**

In `src/features/downloads/repository.ts`, add `torrentHash: row.torrentHash` to `mapAttempt`, and make sure `claimSubmission` inserts it. `update` already spreads a partial patch, so it needs no change beyond the type widening.

- [ ] **Step 6: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0004_*.sql` containing `CREATE TABLE qbittorrent_settings` and `ALTER TABLE download_attempts ADD torrent_hash text`. Confirm it does **not** rebuild `download_attempts` — if it does, something added a constraint that should not be there.

- [ ] **Step 7: Run the tests**

Run: `pnpm test src/features/downloads/repository.test.ts src/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/features/downloads/models.ts src/features/downloads/repository.ts src/features/downloads/repository.test.ts drizzle/
git commit -m "feat(db): add qbittorrent settings and attempt torrent hash"
```

---

### Task 2: qBittorrent settings model, repository, and service

**Files:**
- Modify: `src/features/settings/models.ts`
- Modify: `src/features/settings/repository.ts`
- Modify: `src/features/settings/service.ts`
- Test: `src/features/settings/service.test.ts`, `src/features/settings/repository.test.ts`

**Interfaces:**
- Consumes: `qbittorrentSettings` table (Task 1).
- Produces: `QbittorrentSettingsRecord`, `QbittorrentSettingsInput`, `PublicQbittorrentSettings`, `SettingsRepository.getQbittorrent/saveQbittorrent/recordQbittorrentTest`, `SettingsService.saveQbittorrent`.

- [ ] **Step 1: Write the failing service test**

Add to `src/features/settings/service.test.ts`:

```ts
it("redacts the qBittorrent password", () => {
  const { service, repository } = setup();
  repository.saveQbittorrent({
    baseUrl: "http://qbit.lan:8080",
    username: "admin",
    password: "hunter2",
    defaultCategory: "games",
    lastTestStatus: null,
    lastTestedAt: null,
    configRevision: 1,
    updatedAt: 1
  });
  const redacted = service.getRedacted();
  expect(redacted.qbittorrent).toEqual({
    baseUrl: "http://qbit.lan:8080",
    username: "admin",
    hasPassword: true,
    defaultCategory: "games",
    lastTestStatus: null,
    lastTestedAt: null,
    configRevision: 1
  });
  expect(JSON.stringify(redacted)).not.toContain("hunter2");
});

it("retains the stored password when the update says retain", () => {
  const { service, repository } = setup();
  service.saveQbittorrent({
    baseUrl: "http://qbit.lan:8080",
    username: "admin",
    password: { action: "replace", value: "hunter2" },
    defaultCategory: null
  });
  service.saveQbittorrent({
    baseUrl: "http://qbit.lan:9090",
    username: "admin",
    password: { action: "retain" },
    defaultCategory: null
  });
  expect(repository.getQbittorrent()?.password).toBe("hunter2");
});

it("bumps configRevision only when something changed", () => {
  const { service, repository } = setup();
  const input = {
    baseUrl: "http://qbit.lan:8080",
    username: "admin",
    password: { action: "replace" as const, value: "hunter2" },
    defaultCategory: null
  };
  service.saveQbittorrent(input);
  const first = repository.getQbittorrent()!.configRevision;
  service.saveQbittorrent({ ...input, password: { action: "retain" } });
  expect(repository.getQbittorrent()!.configRevision).toBe(first);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test src/features/settings/service.test.ts`
Expected: FAIL — `saveQbittorrent` is not a function.

- [ ] **Step 3: Add the models**

In `src/features/settings/models.ts`:

```ts
export const qbittorrentSettingsInputSchema = z.object({
  baseUrl: z.url(),
  username: z.string().trim().min(1).max(255),
  password: secretUpdateSchema,
  defaultCategory: z.string().trim().max(255).nullable().default(null)
});

export type QbittorrentSettingsInput =
  z.infer<typeof qbittorrentSettingsInputSchema>;

export interface QbittorrentSettingsRecord {
  baseUrl: string;
  username: string;
  password: string;
  defaultCategory: string | null;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
  updatedAt: number;
}

export interface PublicQbittorrentSettings {
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  defaultCategory: string | null;
  lastTestStatus: string | null;
  lastTestedAt: number | null;
  configRevision: number;
}
```

Add `qbittorrent: PublicQbittorrentSettings | null` to `PublicSettings`.

- [ ] **Step 4: Add the repository methods**

In `src/features/settings/repository.ts`, mirror `getSabnzbd` / `saveSabnzbd` / `recordSabnzbdTest` exactly, against `qbittorrentSettings`.

- [ ] **Step 5: Add the service methods**

In `src/features/settings/service.ts`, extend the `SettingsRepository` interface with the three new methods, add `qbittorrent` to `getRedacted()`, and add `saveQbittorrent` following the shape of `saveSabnzbd`: parse with `parseInput`, resolve the secret with `resolveSecret`, bump `configRevision` only when a field actually changed.

- [ ] **Step 6: Run the tests**

Run: `pnpm test src/features/settings`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/settings/
git commit -m "feat(settings): add qBittorrent connection settings"
```

---

### Task 3: qBittorrent settings API routes

**Files:**
- Modify: `src/app/api/settings/handlers.ts`, `src/app/api/settings/handlers.test.ts`
- Create: `src/app/api/settings/qbittorrent/route.ts`
- Create: `src/app/api/settings/qbittorrent/test/route.ts`

**Interfaces:**
- Consumes: `SettingsService.saveQbittorrent`, `QbittorrentClient` (Task 4 — write this task **after** Task 4, or stub the import and let Task 4 land first).
- Produces: `handlePutQbittorrent`.

> **Ordering note:** this task's test route imports the adapter from Task 4. Implement Task 4 first if you are working strictly sequentially.

- [ ] **Step 1: Write the failing handler test**

Add to `src/app/api/settings/handlers.test.ts`:

```ts
it("rejects a cross-origin qBittorrent update", async () => {
  const response = await handlePutQbittorrent(
    new Request("http://localhost:3000/api/settings/qbittorrent", {
      method: "PUT",
      headers: { origin: "http://evil.test", "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://qbit.lan:8080",
        username: "admin",
        password: { action: "retain" },
        defaultCategory: null
      })
    }),
    dependencies()
  );
  expect(response.status).toBe(403);
});

it("saves a qBittorrent update from a trusted origin", async () => {
  const service = { saveQbittorrent: vi.fn() };
  const response = await handlePutQbittorrent(
    new Request("http://localhost:3000/api/settings/qbittorrent", {
      method: "PUT",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://qbit.lan:8080",
        username: "admin",
        password: { action: "replace", value: "hunter2" },
        defaultCategory: "games"
      })
    }),
    dependencies({ service })
  );
  expect(response.status).toBe(200);
  expect(service.saveQbittorrent).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test src/app/api/settings/handlers.test.ts`
Expected: FAIL — `handlePutQbittorrent` is not exported.

- [ ] **Step 3: Add the handler**

In `src/app/api/settings/handlers.ts`, add `handlePutQbittorrent` mirroring `handlePutSabnzbd`: `assertTrustedMutation`, parse the JSON body, call `service.saveQbittorrent`, return the redacted settings, `errorResponse` on throw. Extend the handler's structural service interface with `saveQbittorrent(input: QbittorrentSettingsInput): void`.

- [ ] **Step 4: Add the routes**

`src/app/api/settings/qbittorrent/route.ts` mirrors the SABnzbd route exactly. `src/app/api/settings/qbittorrent/test/route.ts` mirrors the SABnzbd test route, substituting:

```ts
const settings = repository.getQbittorrent();
if (!settings?.password) {
  throw validationError("qBittorrent is not configured");
}
await new QbittorrentClient({
  baseUrl: settings.baseUrl,
  username: settings.username,
  password: settings.password
}).testConnection();
repository.recordQbittorrentTest("ok", Date.now());
```

with the failure branch recording `"failed"` and the `errorResponse` fallback reading `"qBittorrent connection failed"`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/app/api/settings && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/
git commit -m "feat(api): add qBittorrent settings and connection-test routes"
```

---

### Task 4: TorrentClientPort and the qBittorrent adapter

**Files:**
- Modify: `src/features/downloads/port.ts`
- Create: `src/integrations/qbittorrent/client.ts`
- Test: `src/integrations/qbittorrent/client.test.ts`

**Interfaces:**
- Consumes: `readBoundedJson` from `@/integrations/read-bounded-response`, `AppError` from `@/lib/errors`.
- Produces: `TorrentClientPort`, `TorrentJob`, `TorrentAddError`, `TorrentAddOutcome`, `QbittorrentClient`.

- [ ] **Step 1: Add the port**

In `src/features/downloads/port.ts`:

```ts
/**
 * Whether an add failure is known to have submitted nothing (`rejected`) or
 * might have been accepted before the failure surfaced (`ambiguous`). Only
 * `rejected` is safe to persist as a terminal `Failed`. Exactly the
 * `SabnzbdUploadError` contract, for exactly the same reason.
 */
export type TorrentAddOutcome = "rejected" | "ambiguous";

export class TorrentAddError extends AppError {
  constructor(
    readonly outcome: TorrentAddOutcome,
    message: string,
    options?: ErrorOptions
  ) {
    super("UNAVAILABLE", 502, message, options);
    this.name = "TorrentAddError";
  }
}

export interface TorrentJob {
  hash: string;
  /** A torrent may carry several tags, so attempts match by membership. */
  tags: string[];
  state: string;
  /** Already scaled to 0..100 from qBittorrent's 0..1 fraction. */
  progress: number;
}

export interface TorrentClientPort {
  add(input: {
    torrent: Uint8Array;
    filename: string;
    category: string | null;
    tag: string;
  }): Promise<{ hash: string | null }>;
  /**
   * Every torrent the client knows about, in one request. qBittorrent's `tag=`
   * filter accepts a single value, so filtering server-side would cost one
   * HTTP round trip per in-flight attempt on every reconcile.
   */
  list(): Promise<TorrentJob[]>;
  testConnection(): Promise<void>;
}
```

- [ ] **Step 2: Write the failing adapter tests**

Create `src/integrations/qbittorrent/client.test.ts`. Use a hand-rolled `fetch` fake — no MSW needed. Cover:

```ts
import { describe, expect, it, vi } from "vitest";

import { TorrentAddError } from "@/features/downloads/port";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";

function client(fetchImpl: typeof fetch) {
  return new QbittorrentClient({
    baseUrl: "http://qbit.lan:8080",
    username: "admin",
    password: "hunter2",
    fetch: fetchImpl
  });
}

function loginOk(): Response {
  return new Response("Ok.", {
    status: 200,
    headers: { "set-cookie": "SID=abc123; path=/" }
  });
}

it("logs in once and reuses the SID cookie", async () => {
  const calls: Request[] = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push(new Request(url, init));
    if (url.includes("/auth/login")) return loginOk();
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  const subject = client(fetchImpl);
  await subject.list();
  await subject.list();
  const logins = calls.filter((call) => call.url.includes("/auth/login"));
  expect(logins).toHaveLength(1);
  const listing = calls.filter((call) => call.url.includes("/torrents/info"));
  expect(listing[1]!.headers.get("cookie")).toContain("SID=abc123");
});

it("sends a Referer so qBittorrent's CSRF check passes", async () => {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("referer") ?? "");
    return String(input).includes("/auth/login")
      ? loginOk()
      : new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  await client(fetchImpl).list();
  expect(seen.every((value) => value === "http://qbit.lan:8080")).toBe(true);
});

it("re-logs in once when a request comes back 403", async () => {
  let listCalls = 0;
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
    if (String(input).includes("/auth/login")) return loginOk();
    listCalls += 1;
    return listCalls === 1
      ? new Response("Forbidden", { status: 403 })
      : new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  await expect(client(fetchImpl).list()).resolves.toEqual([]);
  expect(listCalls).toBe(2);
});

it("reads the hash from a WebAPI 2.14 add response", async () => {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
    String(input).includes("/auth/login")
      ? loginOk()
      : new Response(
        JSON.stringify({
          added_torrent_ids: ["8c212779b4abde7c6bc608063a0d008b7e40ce32"],
          success_count: 1,
          pending_count: 0,
          failure_count: 0
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
  const result = await client(fetchImpl).add({
    torrent: new Uint8Array([1, 2, 3]),
    filename: "item.torrent",
    category: null,
    tag: "gamarr-1"
  });
  expect(result.hash).toBe("8c212779b4abde7c6bc608063a0d008b7e40ce32");
});

it("accepts a legacy Ok. add response with no hash", async () => {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
    String(input).includes("/auth/login")
      ? loginOk()
      : new Response("Ok.", { status: 200 })) as unknown as typeof fetch;
  const result = await client(fetchImpl).add({
    torrent: new Uint8Array([1]),
    filename: "item.torrent",
    category: "games",
    tag: "gamarr-1"
  });
  expect(result.hash).toBeNull();
});

it.each([
  [415, "rejected"],
  [409, "rejected"],
  [500, "ambiguous"],
  [502, "ambiguous"]
])("maps add status %i to %s", async (status, outcome) => {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
    String(input).includes("/auth/login")
      ? loginOk()
      : new Response("", { status })) as unknown as typeof fetch;
  await expect(client(fetchImpl).add({
    torrent: new Uint8Array([1]),
    filename: "item.torrent",
    category: null,
    tag: "gamarr-1"
  })).rejects.toMatchObject({ outcome });
});

it("treats a network failure during add as ambiguous", async () => {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
    if (String(input).includes("/auth/login")) return loginOk();
    throw new Error("socket hang up: http://admin:hunter2@qbit.lan:8080");
  }) as unknown as typeof fetch;
  const error = await client(fetchImpl).add({
    torrent: new Uint8Array([1]),
    filename: "item.torrent",
    category: null,
    tag: "gamarr-1"
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(TorrentAddError);
  expect((error as TorrentAddError).outcome).toBe("ambiguous");
  expect((error as TorrentAddError).message).not.toContain("hunter2");
});

it("parses tags and scales progress", async () => {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo) =>
    String(input).includes("/auth/login")
      ? loginOk()
      : new Response(
        JSON.stringify([{
          hash: "abc",
          tags: "gamarr-1, other",
          state: "downloading",
          progress: 0.161
        }]),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
  await expect(client(fetchImpl).list()).resolves.toEqual([
    { hash: "abc", tags: ["gamarr-1", "other"], state: "downloading", progress: 16 }
  ]);
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm test src/integrations/qbittorrent/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the adapter**

Create `src/integrations/qbittorrent/client.ts`. Requirements:

- `apiUrl(path)` joins `{baseUrl}/api/v2/{path}`, tolerating a trailing slash on the base URL.
- Login posts `application/x-www-form-urlencoded` `username`/`password` to `auth/login` and reads the `SID` from `set-cookie`; the cookie is cached on the instance.
- Every request sends `Referer: {origin of baseUrl}` and the cached cookie, uses `redirect: "manual"` and `AbortSignal.timeout(this.timeoutMs)` (default 10s).
- A 403 clears the cached cookie, logs in again, and retries **once**. A second 403 throws.
- `add` builds a `FormData` with a `torrents` `Blob` part (`type: "application/x-bittorrent"`) plus `tags` and, when non-null, `category`. Status → outcome: `415` and `409` → `rejected`; any other non-2xx → `ambiguous`; a thrown network error → `ambiguous`. On 2xx, try to parse JSON with a zod schema for `{ added_torrent_ids?: string[] }`; if the body is not JSON or has no ids, return `{ hash: null }` — the legacy `Ok.` shape is success, not failure.
- `list` GETs `torrents/info`, bounds the body (8 MiB, same constant SABnzbd uses), and parses with a zod schema tolerating a missing `tags`. Split `tags` on `,` and trim each. `progress` is `Math.max(0, Math.min(100, Math.round(value * 100)))`.
- `testConnection` calls `list()` and discards the result.
- **No upstream text is ever forwarded into a thrown message.** Every message is a fixed string written for a user.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/integrations/qbittorrent && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/downloads/port.ts src/integrations/qbittorrent/
git commit -m "feat(qbittorrent): add torrent client port and WebUI adapter"
```

---

### Task 5: Internet Archive torrent detection and fetch

**Files:**
- Modify: `src/features/release-search/file-selection.ts`, `src/features/release-search/file-selection.test.ts`
- Modify: `src/integrations/internet-archive/client.ts`, `src/integrations/internet-archive/client.test.ts`
- Modify: `src/features/release-search/models.ts`

**Interfaces:**
- Consumes: `InternetArchiveFile`, `isSafeInternetArchiveFileName`.
- Produces: `selectItemTorrent(files): ItemTorrent | null`, `InternetArchiveClient.fetchTorrent(identifier, maxBytes, signal?): Promise<Uint8Array>`.

- [ ] **Step 1: Write the failing selection tests**

Add to `src/features/release-search/file-selection.test.ts`:

```ts
import { selectCandidateFiles, selectItemTorrent } from "@/features/release-search/file-selection";

const torrentFile = {
  name: "doom2_archive.torrent",
  size: 41_234,
  format: "Archive BitTorrent",
  source: "metadata"
};

it("finds the item torrent in the manifest", () => {
  expect(selectItemTorrent([
    { name: "doom2.zip", size: 12_000, format: "ZIP", source: "original" },
    torrentFile
  ])).toEqual({ name: "doom2_archive.torrent", size: 41_234 });
});

it("returns null when the item has not been derived", () => {
  expect(selectItemTorrent([
    { name: "doom2.zip", size: 12_000, format: "ZIP", source: "original" }
  ])).toBeNull();
});

it("rejects a torrent whose name fails the path policy", () => {
  expect(selectItemTorrent([
    { name: "../escape_archive.torrent", size: 1, format: null, source: "metadata" }
  ])).toBeNull();
});

it("never lists the torrent among selectable files", () => {
  const files = selectCandidateFiles([
    { name: "doom2.zip", size: 12_000, format: "ZIP", source: "original" },
    torrentFile
  ]);
  expect(files.map((file) => file.name)).toEqual(["doom2.zip"]);
});

it("still excludes the torrent when the item has no originals", () => {
  const files = selectCandidateFiles([
    { name: "doom2.iso", size: 900, format: "ISO", source: "derivative" },
    torrentFile
  ]);
  expect(files.map((file) => file.name)).toEqual(["doom2.iso"]);
});
```

The last test matters: `selectCandidateFiles` falls back to `source !== "metadata"` when there are no originals, which already excludes the torrent — the test pins that so a future relaxation of the filter cannot leak a torrent into the file list, where downloading it would save a useless 40 KB stub.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/features/release-search/file-selection.test.ts`
Expected: FAIL — `selectItemTorrent` is not exported.

- [ ] **Step 3: Add the model and the selector**

In `src/features/release-search/models.ts`:

```ts
/** The whole-item torrent Internet Archive derives for most items. */
export interface ItemTorrent {
  name: string;
  size: number | null;
}
```

In `src/features/release-search/file-selection.ts`:

```ts
/**
 * Internet Archive derives one `{identifier}_archive.torrent` per item,
 * covering the entire item rather than any single file. It lives in the
 * manifest as `source: "metadata"`, which is exactly why
 * `selectCandidateFiles` never returns it — downloading it as a file would
 * save a metainfo stub, not a game.
 *
 * Items that have not been derived have no torrent at all, so absence is a
 * normal answer and never an error.
 */
export function selectItemTorrent(
  files: InternetArchiveFile[]
): ItemTorrent | null {
  const found = files.find((file) =>
    file.source === "metadata"
    && file.name.endsWith("_archive.torrent")
    && isSafeInternetArchiveFileName(file.name));
  return found ? { name: found.name, size: found.size } : null;
}
```

- [ ] **Step 4: Write the failing fetch test**

Add to `src/integrations/internet-archive/client.test.ts` tests asserting that `fetchTorrent` returns the body bytes, throws an `AppError` when the body exceeds `maxBytes`, throws when the response is not ok, and follows a redirect to `*.archive.org` over HTTPS but rejects one to another host.

- [ ] **Step 5: Implement `fetchTorrent`**

Add to `InternetArchiveClient`. It targets
`/download/{encodeURIComponent(identifier)}/{encodeURIComponent(fileName)}`,
validates the identifier with `isValidInternetArchiveIdentifier` first, and
returns bounded bytes via `read-bounded-response` — never touching disk, the
same rule NZBs follow.

The redirect policy duplicated from `InternetArchiveDownloader.assertAllowedTarget` moves to a shared module `src/integrations/internet-archive/redirect-policy.ts` exporting `assertAllowedArchiveTarget(target: URL, baseOrigin: string): void`; both the downloader and the client import it, so the two cannot drift.

- [ ] **Step 6: Run the tests**

Run: `pnpm test src/features/release-search/file-selection.test.ts src/integrations/internet-archive`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/release-search/file-selection.ts src/features/release-search/file-selection.test.ts src/features/release-search/models.ts src/integrations/internet-archive/
git commit -m "feat(internet-archive): detect and fetch the per-item torrent"
```

---

### Task 6: Expose the torrent through `GET /api/releases/files`

**Files:**
- Modify: `src/features/release-search/service.ts`, `src/features/release-search/service.test.ts`
- Modify: `src/features/release-search/ports.ts`
- Modify: `src/app/api/releases/dependencies.ts`
- Modify: `src/app/api/releases/handlers.test.ts`

**Interfaces:**
- Consumes: `selectItemTorrent` (Task 5), `SettingsRepository.getQbittorrent` (Task 2).
- Produces: `CandidateFilesResponse` with `torrent` and `torrentClientConfigured`.

- [ ] **Step 1: Write the failing service test**

Add to `src/features/release-search/service.test.ts`:

```ts
it("returns the item torrent alongside the files", async () => {
  const { service } = setup({
    files: [
      { name: "doom2.zip", size: 12_000, format: "ZIP", source: "original" },
      { name: "doom2_archive.torrent", size: 41_234, format: "Archive BitTorrent", source: "metadata" }
    ],
    qbittorrentConfigured: true
  });
  const response = await service.listCandidateFiles("candidate-1");
  expect(response.files.map((file) => file.name)).toEqual(["doom2.zip"]);
  expect(response.torrent).toEqual({ name: "doom2_archive.torrent", size: 41_234 });
  expect(response.torrentClientConfigured).toBe(true);
});

it("reports the torrent client as unconfigured when no password is stored", async () => {
  const { service } = setup({
    files: [{ name: "doom2_archive.torrent", size: 1, format: null, source: "metadata" }],
    qbittorrentConfigured: false
  });
  const response = await service.listCandidateFiles("candidate-1");
  expect(response.torrent).not.toBeNull();
  expect(response.torrentClientConfigured).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/features/release-search/service.test.ts`
Expected: FAIL — `torrent` is not a property of the response.

- [ ] **Step 3: Widen the response**

In `src/features/release-search/service.ts`:

```ts
export interface CandidateFilesResponse {
  files: SelectableFile[];
  /** Null when the item has not been derived and has no torrent. */
  torrent: ItemTorrent | null;
  /**
   * Whether a torrent client is configured at all. Reported separately from
   * `torrent` so the dialog can show the option disabled with a reason: an
   * operator who expected a torrent should learn why it is unavailable rather
   * than watch it silently vanish.
   */
  torrentClientConfigured: boolean;
}
```

`listCandidateFiles` returns `selectItemTorrent(files)` and reads
`this.dependencies.settings.getQbittorrent()`, treating a missing record or an
empty password as unconfigured. Add the narrow read to whatever settings port
the release-search service already declares; if it declares none, add
`torrentClientConfigured: () => boolean` to its dependencies rather than
importing the settings repository — the feature must not reach past its ports.

- [ ] **Step 4: Wire the composition root**

In `src/app/api/releases/dependencies.ts`, supply the new dependency from
`SqliteSettingsRepository`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/features/release-search src/app/api/releases && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/release-search/ src/app/api/releases/
git commit -m "feat(releases): report the item torrent and client availability"
```

---

### Task 7: Torrent submission in the download service

**Files:**
- Modify: `src/features/downloads/service.ts`, `src/features/downloads/service.test.ts`
- Modify: `src/features/downloads/port.ts`
- Modify: `src/app/api/downloads/handlers.ts`, `src/app/api/downloads/handlers.test.ts`
- Modify: `src/app/api/downloads/dependencies.ts`, `src/app/api/downloads/dependencies.test.ts`

**Interfaces:**
- Consumes: `TorrentClientPort` (Task 4), `InternetArchiveClient.fetchTorrent` and `selectItemTorrent` (Task 5), `getQbittorrent` (Task 2).
- Produces: `DownloadService.submit` accepting `delivery: "torrent"`.

- [ ] **Step 1: Write the failing service tests**

Add to `src/features/downloads/service.test.ts`:

```ts
it("submits a torrent and records the hash", async () => {
  const { service, repository, torrent } = setup({ torrentHash: "abc123" });
  const attempt = await service.submit({
    submissionKey: "key-1",
    candidateId: "ia-candidate",
    gameId: 1,
    platformId: 2,
    delivery: "torrent"
  });
  expect(attempt.status).toBe("Queued");
  expect(attempt.source).toBe("internet-archive-torrent");
  expect(attempt.iaFileName).toBeNull();
  expect(repository.get(attempt.id)!.torrentHash).toBe("abc123");
  expect(torrent.add).toHaveBeenCalledWith(expect.objectContaining({
    tag: `gamarr-${attempt.id}`
  }));
});

it("queues successfully when the client reports no hash", async () => {
  const { service } = setup({ torrentHash: null });
  const attempt = await service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent"
  });
  expect(attempt.status).toBe("Queued");
  expect(attempt.torrentHash).toBeNull();
});

it("replays an identical torrent submission", async () => {
  const { service } = setup({});
  const input = {
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent" as const
  };
  const first = await service.submit(input);
  const second = await service.submit(input);
  expect(second.id).toBe(first.id);
});

it("conflicts when the same key replays with a different delivery", async () => {
  const { service } = setup({});
  await service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent"
  });
  await expect(service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "file", fileName: "doom2.zip"
  })).rejects.toMatchObject({ status: 409 });
});

it("fails the attempt when the client rejects the torrent", async () => {
  const { service } = setup({
    addError: new TorrentAddError("rejected", "qBittorrent rejected the torrent")
  });
  const attempt = await service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent"
  });
  expect(attempt.status).toBe("Failed");
});

it("leaves the attempt Unknown when the acknowledgement is ambiguous", async () => {
  const { service } = setup({
    addError: new TorrentAddError("ambiguous", "qBittorrent did not confirm the torrent")
  });
  const attempt = await service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent"
  });
  expect(attempt.status).toBe("Unknown");
});

it("rejects a torrent submission when qBittorrent is not configured", async () => {
  const { service } = setup({ qbittorrent: null });
  await expect(service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent"
  })).rejects.toMatchObject({ status: 400 });
});

it("rejects a torrent submission for an item with no torrent", async () => {
  const { service } = setup({ torrent: null });
  await expect(service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent"
  })).rejects.toMatchObject({ status: 400 });
});

it("rejects a torrent submission that also names a file", async () => {
  const { service } = setup({});
  await expect(service.submit({
    submissionKey: "key-1", candidateId: "ia-candidate",
    gameId: 1, platformId: 2, delivery: "torrent", fileName: "doom2.zip"
  })).rejects.toMatchObject({ status: 400 });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/features/downloads/service.test.ts`
Expected: FAIL — `delivery` is not honoured.

- [ ] **Step 3: Extend the port config**

In `src/features/downloads/port.ts`, add:

```ts
/**
 * Everything the torrent path needs, bound in the composition root. Separate
 * from `InternetArchiveDownloadConfig` because the two deliveries share no
 * machinery: one streams bytes to disk under a heartbeat, the other hands
 * metainfo to a client that owns the download from then on.
 */
export interface InternetArchiveTorrentConfig {
  /** Resolves the item's `_archive.torrent`, or null when it has none. */
  findTorrent(identifier: string): Promise<ItemTorrent | null>;
  fetchTorrent(identifier: string, fileName: string): Promise<Uint8Array>;
  client(): TorrentClientPort | null;
  defaultCategory: string | null;
}
```

Add `internetArchiveTorrent?: InternetArchiveTorrentConfig` to
`DownloadServiceDependencies`.

- [ ] **Step 4: Extend the fingerprint**

In `src/features/downloads/service.ts`, widen the `source` parameter to
`AttemptSourceType` and add one branch to the identity switch. **The hashed
value must stay `JSON.stringify(identity)`** — do not wrap it, salt it, or add
the source to it. Any change to how existing sources hash invalidates every
`request_fingerprint` already stored in a deployed database, turning every
later replay into a spurious 409.

```ts
function fingerprint(
  input: SubmitDownloadInput,
  source: AttemptSourceType
): string {
  // Identity is derived from the attempt's source, never from which optional
  // fields happen to be present. The Newznab shape is deliberately the
  // 3-element array earlier versions wrote, so rows already in deployed
  // databases keep matching. The torrent shape omits the file name — a torrent
  // covers the whole item — and carries a trailing discriminator so it can
  // never collide with the 3-element Newznab array.
  const identity = source === "internet-archive"
    ? [input.candidateId, input.gameId, input.platformId, selectedFileName(input)]
    : source === "internet-archive-torrent"
      ? [input.candidateId, input.gameId, input.platformId, "torrent"]
      : [input.candidateId, input.gameId, input.platformId];
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}
```

The torrent array collides with an Internet Archive *file* array only if a file
were literally named `torrent`. Even then the two never compare equal:
`assertSameRequest` recomputes from the **stored** attempt's source, so a
torrent attempt is only ever compared against the torrent formula.

Add a regression test pinning the Newznab fingerprint to a literal hex digest,
so a future edit to this function cannot silently invalidate deployed rows:

```ts
it("keeps the legacy Newznab fingerprint stable", () => {
  // Computed from JSON.stringify(["cand-1", 1, 2]) — if this test fails, the
  // change under it will 409 every replay in every deployed database.
  expect(fingerprintForTest(
    { submissionKey: "k", candidateId: "cand-1", gameId: 1, platformId: 2 },
    "newznab"
  )).toBe(
    createHash("sha256").update(JSON.stringify(["cand-1", 1, 2])).digest("hex")
  );
});
```

- [ ] **Step 5: Implement `submitInternetArchiveTorrent`**

Branch in `submit()` after the candidate is resolved:

```ts
if (candidate.source === "internet-archive") {
  return input.delivery === "torrent"
    ? this.submitInternetArchiveTorrent(input, candidate)
    : this.submitInternetArchive(input, candidate);
}
```

The new method, in order:

1. `if (input.fileName !== undefined) throw validationError("A torrent covers the whole item; do not select a file");`
2. Read `config = this.dependencies.internetArchiveTorrent`; absent → `validationError("Internet Archive torrents are not configured")`.
3. `const client = config.client(); if (!client) throw validationError("qBittorrent is not configured");`
4. Validate `candidate.guid` with `isValidInternetArchiveIdentifier`.
5. `const torrent = await config.findTorrent(identifier); if (!torrent) throw validationError("This item has no torrent; download a file instead");`
6. `claimSubmission` at `Pending` with `source: "internet-archive-torrent"`, `iaFileName: null`, `torrentHash: null`, `indexerId: null`, `indexerNameSnapshot` from the candidate snapshot or `INTERNET_ARCHIVE_INDEXER_NAME`, `size: candidate.size`, `category: config.defaultCategory`, `sabnzbdConfigRevision: 0`, `sabMarker: gamarr-${attemptId}`. On `!claimed.created`, `assertSameRequest`.
7. Fetch bytes in a `try`; on failure `update` to `Failed` with the `AppError` message or `"Torrent retrieval failed"`.
8. `update` to `Submitting` with `sabRequestStartedAt`.
9. `client.add({ torrent: bytes, filename: torrent.name, category: config.defaultCategory, tag: sabMarker })`. Success → `Queued` plus `torrentHash: result.hash`. On `TorrentAddError`, `Failed` when `outcome === "rejected"` else `Unknown`; on anything else, `Unknown` with `"qBittorrent acknowledgement was not confirmed"`.

There is **no heartbeat** on this path — qBittorrent owns the download, and the attempt is not orphaned by a Gamarr restart.

- [ ] **Step 6: Accept `delivery` at the API boundary**

In `src/app/api/downloads/handlers.ts`, extend the request schema with
`delivery: z.enum(["file", "torrent"]).optional()` and pass it through. Add a
handler test asserting an unknown `delivery` value is a 400.

- [ ] **Step 7: Wire the composition root**

In `src/app/api/downloads/dependencies.ts`, build the config:

```ts
const settings = new SqliteSettingsRepository(database);
// ...
internetArchiveTorrent: {
  findTorrent: async (identifier) =>
    selectItemTorrent(await iaClient.listFiles(identifier)),
  fetchTorrent: (identifier, fileName) =>
    iaClient.fetchTorrent(identifier, fileName, internetArchiveTorrentMaxBytes()),
  client: () => {
    const qbit = settings.getQbittorrent();
    if (!qbit?.password) return null;
    return new QbittorrentClient({
      baseUrl: qbit.baseUrl,
      username: qbit.username,
      password: qbit.password
    });
  },
  defaultCategory: settings.getQbittorrent()?.defaultCategory ?? null
}
```

with

```ts
const DEFAULT_IA_TORRENT_MAX_BYTES = 8 * 1024 * 1024;

function internetArchiveTorrentMaxBytes(): number {
  return byteLimitFromEnv(process.env.GAMARR_IA_TORRENT_MAX_BYTES)
    ?? DEFAULT_IA_TORRENT_MAX_BYTES;
}
```

`client()` is a factory rather than a value so a settings change between
requests is picked up without a restart, matching `sabFactory`.

- [ ] **Step 8: Run the tests**

Run: `pnpm test src/features/downloads src/app/api/downloads && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/features/downloads/ src/app/api/downloads/
git commit -m "feat(downloads): submit Internet Archive items to qBittorrent"
```

---

### Task 8: Reconcile the torrent branch

**Files:**
- Modify: `src/features/downloads/service.ts`, `src/features/downloads/service.test.ts`

**Interfaces:**
- Consumes: `TorrentClientPort.list()` (Task 4), the config from Task 7.
- Produces: nothing new; `reconcile` gains a second branch.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ["uploading", "Completed"],
  ["stalledUP", "Completed"],
  ["pausedUP", "Completed"],
  ["error", "Failed"],
  ["missingFiles", "Failed"],
  ["downloading", "Downloading"],
  ["metaDL", "Downloading"],
  ["queuedDL", "Queued"]
])("maps torrent state %s to %s", async (state, expected) => {
  const { service, attempt } = await queuedTorrent();
  const [result] = await service.reconcile([attempt.id], {
    torrents: [{ hash: "abc123", tags: [attempt.sabMarker], state, progress: 50 }]
  });
  expect(result!.status).toBe(expected);
});

it("leaves an unrecognised torrent state untouched", async () => {
  const { service, attempt } = await queuedTorrent();
  const [result] = await service.reconcile([attempt.id], {
    torrents: [{ hash: "abc123", tags: [attempt.sabMarker], state: "someFutureState", progress: 50 }]
  });
  expect(result!.status).toBe("Queued");
});

it("matches by tag when no hash was recorded", async () => {
  const { service, attempt } = await queuedTorrent({ torrentHash: null });
  const [result] = await service.reconcile([attempt.id], {
    torrents: [{ hash: "abc123", tags: ["other", attempt.sabMarker], state: "uploading", progress: 100 }]
  });
  expect(result!.status).toBe("Completed");
  expect(result!.progress).toBe(100);
});

it("reconciles torrents with SABnzbd entirely unconfigured", async () => {
  const { service, attempt } = await queuedTorrent({ sabnzbd: null });
  const [result] = await service.reconcile([attempt.id], {
    torrents: [{ hash: "abc123", tags: [attempt.sabMarker], state: "uploading", progress: 100 }]
  });
  expect(result!.status).toBe("Completed");
});

it("does not fail an in-flight torrent during stale recovery", () => {
  const { service, repository, attempt } = queuedTorrentSync();
  service.recoverStaleSubmissions(0);
  expect(repository.get(attempt.id)!.status).toBe("Queued");
});
```

(The `{ torrents: [...] }` second argument is illustrative of the fake — drive
it through the injected `TorrentClientPort` fake rather than a new parameter on
`reconcile`, whose signature must stay `reconcile(ids?: string[])`.)

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/features/downloads/service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Split reconcile into independent branches**

Restructure `reconcile` so the SABnzbd lookup and the torrent lookup are
attempted independently, each swallowing its own failure. The current early
`return this.selected(ids)` when SABnzbd is unconfigured must go — a
torrent-only operator never configures SABnzbd, and today that would silently
disable all reconciliation.

Extract the SABnzbd body into `reconcileSabnzbd(attempts, timestamp)` and add:

```ts
/**
 * qBittorrent states, mapped the same way SABnzbd history is: only
 * `Completed` and `Failed` are terminal, and an unrecognised state returns
 * null meaning "no verdict yet". Writing a terminal status on a state this
 * table does not know would be permanent, because reconcile never revisits a
 * Completed or Failed attempt.
 */
const torrentStatuses: Record<string, DownloadStatus> = {
  uploading: "Completed",
  stalledUP: "Completed",
  pausedUP: "Completed",
  queuedUP: "Completed",
  forcedUP: "Completed",
  checkingUP: "Completed",
  error: "Failed",
  missingFiles: "Failed",
  downloading: "Downloading",
  stalledDL: "Downloading",
  metaDL: "Downloading",
  forcedDL: "Downloading",
  checkingDL: "Downloading",
  allocating: "Downloading",
  queuedDL: "Queued",
  pausedDL: "Queued",
  checkingResumeData: "Queued",
  moving: "Queued"
};

function statusFromTorrent(state: string): DownloadStatus | null {
  return torrentStatuses[state] ?? null;
}
```

The torrent branch calls `client.list()` once, then for each non-terminal
attempt whose `source === "internet-archive-torrent"` finds the job by
`torrentHash` when set, otherwise by `tags.includes(attempt.sabMarker)`. It
writes `status`, `progress` (100 on completion, else the job's), `torrentHash`
when it was previously null, `failureDetail` on failure, `completedAt`, and
`updatedAt`.

- [ ] **Step 4: Assert recovery excludes torrents**

`recoverStaleInternetArchiveDownloads` filters `eq(source, "internet-archive")`,
so torrent attempts are excluded by construction. Keep it that way and let the
new test pin it — the two source strings share a prefix, and a future
`like("internet-archive%")` would silently fail live torrents on every restart.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/features/downloads && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/downloads/
git commit -m "feat(downloads): reconcile torrent attempts independently of SABnzbd"
```

---

### Task 9: Download dialog and source labels

**Files:**
- Modify: `src/features/release-search/download-dialog.tsx`, `src/features/release-search/download-dialog.test.tsx`
- Modify: `src/features/library/activity-screen.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: the `GET /api/releases/files` response from Task 6, the `delivery` field from Task 7.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing component tests**

Add to `src/features/release-search/download-dialog.test.tsx` (the file already carries the `/** @vitest-environment jsdom */` docblock):

```ts
it("pins the torrent entry above the files", async () => {
  renderDialog({ torrent: { name: "doom2_archive.torrent", size: 1_400_000_000 }, torrentClientConfigured: true });
  const options = await screen.findAllByRole("radio");
  expect(options[0]).toHaveAccessibleName(/entire item \(torrent\)/i);
});

it("switches the submit label when the torrent is selected", async () => {
  renderDialog({ torrent: { name: "doom2_archive.torrent", size: 1 }, torrentClientConfigured: true });
  expect(await screen.findByRole("button", { name: /download file/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: /entire item \(torrent\)/i }));
  expect(screen.getByRole("button", { name: /send to qbittorrent/i })).toBeInTheDocument();
});

it("submits delivery torrent with no file name", async () => {
  const fetchMock = renderDialog({ torrent: { name: "doom2_archive.torrent", size: 1 }, torrentClientConfigured: true });
  await userEvent.click(await screen.findByRole("radio", { name: /entire item \(torrent\)/i }));
  await userEvent.click(screen.getByRole("button", { name: /send to qbittorrent/i }));
  const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
  expect(body).toMatchObject({ delivery: "torrent" });
  expect(body.fileName).toBeUndefined();
});

it("still submits delivery file for a file selection", async () => {
  const fetchMock = renderDialog({ torrent: null, torrentClientConfigured: false });
  await userEvent.click(await screen.findByRole("button", { name: /download file/i }));
  const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
  expect(body).toMatchObject({ delivery: "file", fileName: "doom2.zip" });
});

it("disables the torrent entry with a reason when qBittorrent is unconfigured", async () => {
  renderDialog({ torrent: { name: "doom2_archive.torrent", size: 1 }, torrentClientConfigured: false });
  const option = await screen.findByRole("radio", { name: /entire item \(torrent\)/i });
  expect(option).toBeDisabled();
  expect(screen.getByText(/qbittorrent is not configured/i)).toBeInTheDocument();
});

it("omits the torrent entry when the item has none", async () => {
  renderDialog({ torrent: null, torrentClientConfigured: true });
  await screen.findByRole("radio", { name: /doom2\.zip/i });
  expect(screen.queryByRole("radio", { name: /entire item/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/features/release-search/download-dialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the dialog change**

- Replace `selectedFile: string | null` with `selection: { kind: "torrent" } | { kind: "file"; name: string } | null`. The default stays the largest file — direct download is the established behaviour, and making the torrent the default would change what an existing operator gets from an unchanged gesture.
- Render the torrent entry first inside the existing `<fieldset className="file-picker">`, followed by an `<hr className="file-picker-divider" />`, then the files. Change the legend to "Select what to download".
- The torrent option's label reads `Entire item (torrent)`, with meta text `{formatBytes(size)} · via qBittorrent`, or `qBittorrent is not configured` when `torrentClientConfigured` is false, in which case the `<input>` is `disabled`.
- Submit label: `Send to qBittorrent` for a torrent selection, `Download file` otherwise. Submitting sends `delivery: "torrent"` with no `fileName`, or `delivery: "file"` with the name.
- The success state reads "Added to qBittorrent" / "The job is saved in your Gamarr library and queued in qBittorrent."

Style the divider in `globals.css` as a plain rule. **No meaning may be carried by colour alone** — the distinction lives in the label text.

- [ ] **Step 4: Label the source in Activity**

In `src/features/library/activity-screen.tsx`, render `internet-archive-torrent` as "Internet Archive (torrent)". Grep for other `source ===` comparisons in `src/features/` and `src/app/` and handle the new value everywhere it appears — a bare equality check against `"internet-archive"` will now silently mis-label torrent attempts.

- [ ] **Step 5: Run the tests**

Run: `pnpm test src/features/release-search src/features/library && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/release-search/ src/features/library/ src/app/globals.css
git commit -m "feat(ui): offer the whole-item torrent in the download dialog"
```

---

### Task 10: qBittorrent settings screen

**Files:**
- Modify: `src/features/settings/settings-screen.tsx` and its colocated test

**Interfaces:**
- Consumes: `PublicQbittorrentSettings` (Task 2), the routes from Task 3.

- [ ] **Step 1: Write the failing test**

Assert the card renders the stored base URL and username, shows the password as
set without revealing it, submits a `retain` action when the field is left
blank, and surfaces the result of the connection test.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/features/settings`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add a qBittorrent card mirroring the SABnzbd card: base URL, username, password
(placeholder only, never the value), default category, Save, and Test
connection. The password input must never be populated from the response —
`hasPassword` only drives placeholder text.

- [ ] **Step 4: Run the tests**

Run: `pnpm test src/features/settings && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/
git commit -m "feat(settings): add the qBittorrent settings card"
```

---

### Task 11: End-to-end coverage

**Files:**
- Modify: `tests/provider-server/server.ts`
- Create: `tests/e2e/internet-archive-torrent.spec.ts`
- Modify: `playwright.config.ts` (only if a new env var must be passed through)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Extend the stub provider**

Serve `GET /download/:identifier/:identifier_archive.torrent` with a small
fixed byte payload, and include a `_archive.torrent` entry with
`source: "metadata"` in the `/metadata/:identifier` manifest.

Add a stub qBittorrent on the same server under a distinct path prefix:
`POST /api/v2/auth/login` returning `Ok.` with a `SID` cookie,
`POST /api/v2/torrents/add` returning `{"added_torrent_ids":["abc123"],
"success_count":1,"pending_count":0,"failure_count":0}`, and
`GET /api/v2/torrents/info` returning one torrent whose `tags` echoes the tag
the add call received and whose state advances from `downloading` to
`uploading` on the second poll.

- [ ] **Step 2: Write the spec**

`tests/e2e/internet-archive-torrent.spec.ts`, modelled on
`tests/e2e/internet-archive-download.spec.ts`: configure qBittorrent through
the settings UI pointed at the stub, search, open the dialog, assert the
torrent entry is first, select it, submit, assert the attempt shows in Activity
as `Queued`, refresh to reconcile, assert `Completed`. Include an
`@axe-core/playwright` pass against the open dialog.

- [ ] **Step 3: Run it**

Run: `pnpm exec playwright test tests/e2e/internet-archive-torrent.spec.ts`
Expected: PASS. E2E runs single-worker and non-parallel because it shares one
SQLite file — do not add a worker.

- [ ] **Step 4: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 5: Update the docs**

Add `GAMARR_IA_TORRENT_MAX_BYTES` to the environment-variable table in
`CLAUDE.md` and in `README.md` if it carries one. Add a sentence to the
Internet Archive paragraph in `CLAUDE.md` noting that an item may instead be
handed to qBittorrent as a whole-item torrent, and that those attempts survive
a restart while direct downloads do not.

- [ ] **Step 6: Commit**

```bash
git add tests/ CLAUDE.md README.md playwright.config.ts
git commit -m "test(e2e): cover the Internet Archive torrent path"
```

---

## Self-review notes

Checked against the spec:

- Data model, ports, request path, lifecycle, reconcile, recovery, settings, UX, testing, and the env var each map to a task.
- The duplicate-item limitation needs no task: it resolves to `Unknown`, which Task 7's `ambiguous` branch already produces.
- `AttemptSourceType` (Task 1), `ItemTorrent` (Task 5), `TorrentJob`/`TorrentAddError` (Task 4), `InternetArchiveTorrentConfig` (Task 7) are each defined once and referenced consistently thereafter.
- Task 3 depends on Task 4's adapter; the ordering note is on the task.
