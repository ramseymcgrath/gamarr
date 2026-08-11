# Prowlarr Torrent Indexers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gamarr's hand-configured Newznab indexer list and its bespoke Internet Archive integration with a single Prowlarr connection that searches every enabled indexer and routes results by protocol — torrents to qBittorrent, usenet to SABnzbd.

**Architecture:** One `src/integrations/prowlarr/` adapter implements discovery (`GET /api/v1/indexer`) and per-indexer search (`GET /api/v1/indexer/{id}/newznab`). `Release` carries `protocol: "usenet" | "torrent"` as an ordinary field rather than a parallel code path. Torrent payloads reach qBittorrent as `.torrent` bytes or as a validated magnet URI; per-file selection is applied through qBittorrent file priorities on the reconcile pass, since a magnet has no file list until metadata arrives.

**Tech Stack:** Next.js 15 App Router, TypeScript, better-sqlite3 + Drizzle, Zod, fast-xml-parser, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-11-prowlarr-torrent-indexers-design.md` — authoritative. Read it before starting any task.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 24 or newer, pnpm.** `corepack enable`. 24 is a floor, not a pin — a newer runtime is fine. Never use `npm` or `yarn`.
- **Verification commands:** `pnpm lint`, `pnpm typecheck`, `pnpm test`. A single file: `pnpm test path/to/file.test.ts`. A single case: `pnpm test -t "case name"`.
- **Tests are colocated** next to the source as `*.test.ts` / `*.test.tsx`. Vitest environment is `node` by default; component tests need a first-line `/** @vitest-environment jsdom */` docblock.
- **Path aliases:** `@/*` → `src/*`, `@tests/*` → `tests/*`.
- **`clearMocks` and `restoreMocks` are on globally** — never hand-roll spy teardown.
- **Prefer hand-written fakes** implementing a port over module mocking.
- **Errors:** throw `AppError` (or the `validationError` / `forbiddenError` helpers) from `@/lib/errors`. Anything that is not an `AppError` becomes a generic 500. Never let a raw upstream error message through — it may carry a credential.
- **Secrets must never reach the client.** The Prowlarr API key must never appear in an API response, a warning message, an error message, a React Query key, or a URL that Gamarr constructs. Use the `X-Api-Key` header, never an `apikey` query parameter, for requests Gamarr builds.
- **Migrations in `drizzle/` are immutable once committed.** Never edit an applied migration; always generate a new one with `pnpm db:generate`.
- **better-sqlite3 is synchronous.** Transactions must be short and must never contain an external `await`. Claim the row first, then do network I/O outside the transaction.
- **API route four-file split** is mandatory: `route.ts` (thin shim, `runtime = "nodejs"`, `dynamic = "force-dynamic"`), `dependencies.ts` (`import "server-only"`, composition root), `handlers.ts` (logic, takes dependencies as a parameter), `handlers.test.ts` (hand-rolled fakes). Handlers declare a narrow structural interface for the service they need rather than importing the concrete class.
- **Feature slices** use `models.ts` / `ports.ts` / `repository.ts` / `service.ts`. Features reach the outside world only through ports; `dependencies.ts` binds a port to a concrete adapter. Features never import integration clients, except pure validation modules with no I/O.
- **Accessibility is a requirement** (WCAG 2.2 AA, asserted in e2e via `@axe-core/playwright`). Status, match rank, and protocol must encode meaning in text *and* icon/shape, never colour alone.
- **Commit after every task.** Use conventional commit prefixes (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`).
- **Do not delete `src/integrations/newznab/` or `src/integrations/internet-archive/` before Task 14.** Earlier tasks add the Prowlarr modules alongside them; the codebase must typecheck at every commit.

---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/integrations/prowlarr/magnet-policy.ts` | Validate `magnet:` URIs; reject credential echoes |
| `src/integrations/prowlarr/metainfo.ts` | Minimal bencode decoder → torrent file list |
| `src/integrations/prowlarr/feed.ts` | Newznab/Torznab RSS → `Release[]` |
| `src/integrations/prowlarr/url-policy.ts` | Same-origin validation against the Prowlarr base URL |
| `src/integrations/prowlarr/client.ts` | `ProwlarrPort`: discovery + per-indexer search |
| `src/integrations/prowlarr/fetch.ts` | `ReleaseFetcherPort`: bounded fetch, manual redirects, magnet terminal |
| `drizzle/0006_*.sql` | Migration: `prowlarr_settings`, `platform_categories`, table rebuilds, drops |

**Modified:** `src/db/schema.ts`, `src/features/settings/{models,repository,service,settings-screen,setup-screen}.ts(x)`, `src/features/release-search/{models,ports,service,file-selection,repository,release-results,download-dialog}.ts(x)`, `src/features/downloads/{models,port,repository,service}.ts`, `src/features/catalog/repository.ts`, `src/integrations/qbittorrent/client.ts`, `src/app/api/{settings,releases,downloads,platforms}/**`, `tests/provider-server/**`, `tests/e2e/**`, `CLAUDE.md`, `README.md`.

**Deleted (Task 14 only):** `src/integrations/newznab/`, `src/integrations/internet-archive/`.

---

## Task 1: Magnet URI policy

Pure module, no I/O, no dependencies on other tasks. Can run in parallel with Tasks 2 and 3.

**Files:**
- Create: `src/integrations/prowlarr/magnet-policy.ts`
- Test: `src/integrations/prowlarr/magnet-policy.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors`.
- Produces:
  ```ts
  export type MagnetRejectionReason =
    | "malformed" | "unsupportedScheme" | "missingInfoHash"
    | "unsupportedTopic" | "tooLong" | "credentialExposed";
  export class MagnetPolicyError extends AppError {
    readonly reason: MagnetRejectionReason;
  }
  export function validateMagnet(uri: string, apiKey: string): string;
  ```
  `validateMagnet` returns the URI unchanged when it passes, and throws `MagnetPolicyError` otherwise. Tasks 6 and 10 call it.

**Background:** Prowlarr answers `GET /api/v1/indexer/{id}/download?link=…` with a `302` to a `magnet:` URI for trackers that publish no `.torrent`. That URI goes straight to qBittorrent, so it is untrusted input on a path to another service. `MagnetPolicyError` must never embed the offending URI in its message — these messages surface in user-facing warnings and a redirect could have echoed the API key into the URI.

- [ ] **Step 1: Write the failing test**

Create `src/integrations/prowlarr/magnet-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  MagnetPolicyError,
  validateMagnet
} from "@/integrations/prowlarr/magnet-policy";

const KEY = "prowlarr-secret-key";
const HEX = "0123456789abcdef0123456789abcdef01234567";
const BASE32 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function reasonOf(uri: string, apiKey = KEY): string {
  try {
    validateMagnet(uri, apiKey);
  } catch (error) {
    if (error instanceof MagnetPolicyError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("validateMagnet", () => {
  it("accepts a 40-character hex infohash", () => {
    const uri = `magnet:?xt=urn:btih:${HEX}&dn=Some+Game`;
    expect(validateMagnet(uri, KEY)).toBe(uri);
  });

  it("accepts a 32-character base32 infohash", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${BASE32}`)).toBe("accepted");
  });

  it("accepts an uppercase hex infohash", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX.toUpperCase()}`)).toBe("accepted");
  });

  it("keeps tracker parameters untouched", () => {
    const uri = `magnet:?xt=urn:btih:${HEX}&tr=udp%3A%2F%2Ftracker.test%3A80`;
    expect(validateMagnet(uri, KEY)).toBe(uri);
  });

  it("rejects a non-magnet scheme", () => {
    expect(reasonOf(`https://tracker.test/?xt=urn:btih:${HEX}`))
      .toBe("unsupportedScheme");
  });

  it("rejects a magnet with no xt parameter", () => {
    expect(reasonOf("magnet:?dn=Some+Game")).toBe("missingInfoHash");
  });

  it("rejects a non-btih topic", () => {
    expect(reasonOf(`magnet:?xt=urn:sha1:${BASE32}`)).toBe("unsupportedTopic");
  });

  it("rejects a btih topic whose infohash is the wrong length", () => {
    expect(reasonOf("magnet:?xt=urn:btih:abc123")).toBe("missingInfoHash");
  });

  it("rejects when any xt is a non-btih topic", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}&xt=urn:sha1:${BASE32}`))
      .toBe("unsupportedTopic");
  });

  it("rejects a URI longer than 4096 characters", () => {
    const long = `magnet:?xt=urn:btih:${HEX}&dn=${"a".repeat(4096)}`;
    expect(reasonOf(long)).toBe("tooLong");
  });

  it("rejects a URI containing the configured API key", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}&tr=http%3A%2F%2Fx%2F${KEY}`))
      .toBe("credentialExposed");
  });

  it("rejects a URI containing the API key percent-encoded", () => {
    const encoded = encodeURIComponent(KEY).replace(/-/g, "%2D");
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}&dn=${encoded}`))
      .toBe("credentialExposed");
  });

  it("does not treat an empty API key as present in every URI", () => {
    expect(reasonOf(`magnet:?xt=urn:btih:${HEX}`, "")).toBe("accepted");
  });

  it("rejects an unparseable URI", () => {
    expect(reasonOf("magnet:%%%")).toBe("malformed");
  });

  it("never includes the offending URI in the message", () => {
    try {
      validateMagnet(`magnet:?xt=urn:btih:${HEX}&tr=${KEY}`, KEY);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MagnetPolicyError);
      expect((error as MagnetPolicyError).message).not.toContain(KEY);
      expect((error as MagnetPolicyError).message).not.toContain(HEX);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/integrations/prowlarr/magnet-policy.test.ts`
Expected: FAIL — cannot resolve `@/integrations/prowlarr/magnet-policy`.

- [ ] **Step 3: Write minimal implementation**

Create `src/integrations/prowlarr/magnet-policy.ts`:

```ts
import { AppError } from "@/lib/errors";

/** Generous for a magnet with many trackers, tight enough to bound parsing. */
const maxMagnetLength = 4096;
const hexInfoHash = /^[0-9a-fA-F]{40}$/;
const base32InfoHash = /^[A-Z2-7]{32}$/i;
const btihPrefix = "urn:btih:";

export type MagnetRejectionReason =
  | "malformed"
  | "unsupportedScheme"
  | "missingInfoHash"
  | "unsupportedTopic"
  | "tooLong"
  | "credentialExposed";

/**
 * A per-release rejection, shaped like `DownloadUrlPolicyError`. The offending
 * URI is deliberately never stored on the error: a redirect can echo the
 * Prowlarr API key into it, and these messages reach user-facing warnings.
 */
export class MagnetPolicyError extends AppError {
  constructor(
    readonly reason: MagnetRejectionReason,
    message: string
  ) {
    super("VALIDATION", 400, message);
    this.name = "MagnetPolicyError";
  }
}

/**
 * Decoded once so a percent-encoded credential is caught too. Decoding can
 * throw on malformed escapes, which is itself a rejection.
 */
function decodedForms(uri: string): string[] {
  const forms = [uri];
  try {
    forms.push(decodeURIComponent(uri));
  } catch {
    throw new MagnetPolicyError("malformed", "Magnet URI is malformed");
  }
  return forms;
}

export function validateMagnet(uri: string, apiKey: string): string {
  if (uri.length > maxMagnetLength) {
    throw new MagnetPolicyError("tooLong", "Magnet URI is too long");
  }

  const forms = decodedForms(uri);

  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    throw new MagnetPolicyError("malformed", "Magnet URI is malformed");
  }

  if (target.protocol !== "magnet:") {
    throw new MagnetPolicyError(
      "unsupportedScheme",
      "Torrent link must use the magnet scheme"
    );
  }

  const topics = target.searchParams.getAll("xt");
  if (topics.some((topic) => !topic.startsWith(btihPrefix))) {
    throw new MagnetPolicyError(
      "unsupportedTopic",
      "Magnet URI declares an unsupported topic type"
    );
  }

  const hashes = topics.map((topic) => topic.slice(btihPrefix.length));
  const usable = hashes.some((hash) =>
    hexInfoHash.test(hash) || base32InfoHash.test(hash));
  if (!usable) {
    throw new MagnetPolicyError(
      "missingInfoHash",
      "Magnet URI carries no usable BitTorrent info hash"
    );
  }

  // Checked last so a redirect that smuggles the key into an otherwise valid
  // magnet is still caught, and checked against both raw and decoded forms.
  if (apiKey.length > 0 && forms.some((form) => form.includes(apiKey))) {
    throw new MagnetPolicyError(
      "credentialExposed",
      "Torrent link exposed the configured Prowlarr credential"
    );
  }

  return uri;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/integrations/prowlarr/magnet-policy.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/prowlarr/magnet-policy.ts src/integrations/prowlarr/magnet-policy.test.ts
git commit -m "feat(prowlarr): validate magnet URIs before they reach qBittorrent"
```

---

## Task 2: Torrent metainfo decoder

Pure module, no I/O. Can run in parallel with Tasks 1 and 3.

**Files:**
- Create: `src/integrations/prowlarr/metainfo.ts`
- Test: `src/integrations/prowlarr/metainfo.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors`.
- Produces:
  ```ts
  export interface TorrentFile {
    index: number;
    name: string;
    size: number | null;
  }
  export function decodeTorrentFiles(bytes: Uint8Array): TorrentFile[];
  ```
  Tasks 9 and 12 call `decodeTorrentFiles` to populate `GET /api/releases/files`.

**Background:** A `.torrent` is a bencoded dictionary. Bencode has four types: integers `i<digits>e`, byte strings `<length>:<bytes>`, lists `l<items>e`, dictionaries `d<key><value>…e`. This decoder reads only what the file list needs and treats the input as hostile: the byte length is already capped at 8 MiB by the caller, but nesting depth, truncation, trailing garbage and a non-dictionary root must all be rejected here.

File ordering is load-bearing. qBittorrent enumerates a torrent's files in the order `info.files` declares them, so the `index` this returns is the same index `torrents/filePrio` expects. Multi-file entries are named `${info.name}/${path.join("/")}` to match how qBittorrent reports them. A single-file torrent yields exactly one entry at index 0 named `info.name`.

- [ ] **Step 1: Write the failing test**

Create `src/integrations/prowlarr/metainfo.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decodeTorrentFiles } from "@/integrations/prowlarr/metainfo";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Bencode string lengths are byte counts and must be exact — `a.xci` is 5
 * bytes, so it is `5:a.xci`. A decoder that accepts a wrong count is broken.
 */
const singleFile = bytes("d4:infod6:lengthi1024e4:name8:Game.xciee");

const multiFile = bytes(
  "d4:infod5:filesld6:lengthi10e4:pathl5:a.xciee"
  + "d6:lengthi20e4:pathl3:sub5:b.xcieee"
  + "4:name10:Collectionee"
);

describe("decodeTorrentFiles", () => {
  it("returns one entry for a single-file torrent", () => {
    expect(decodeTorrentFiles(singleFile)).toEqual([
      { index: 0, name: "Game.xci", size: 1024 }
    ]);
  });

  it("returns declaration-ordered entries for a multi-file torrent", () => {
    expect(decodeTorrentFiles(multiFile)).toEqual([
      { index: 0, name: "Collection/a.xci", size: 10 },
      { index: 1, name: "Collection/sub/b.xci", size: 20 }
    ]);
  });

  it("rejects a non-dictionary root", () => {
    expect(() => decodeTorrentFiles(bytes("li1ee")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects trailing garbage after the root dictionary", () => {
    const trailing = new Uint8Array([...singleFile, ...bytes("junk")]);
    expect(() => decodeTorrentFiles(trailing)).toThrow(/malformed torrent/i);
  });

  it("rejects truncated input", () => {
    expect(() => decodeTorrentFiles(singleFile.slice(0, 20)))
      .toThrow(/malformed torrent/i);
  });

  it("rejects a string whose declared length exceeds the buffer", () => {
    expect(() => decodeTorrentFiles(bytes("d4:infod4:name99:xee")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects deeply nested input", () => {
    const depth = 64;
    const bomb = bytes("l".repeat(depth) + "e".repeat(depth));
    expect(() => decodeTorrentFiles(bomb)).toThrow(/malformed torrent/i);
  });

  it("rejects a torrent with no info dictionary", () => {
    expect(() => decodeTorrentFiles(bytes("d8:announce3:abce")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects a negative file length", () => {
    expect(() => decodeTorrentFiles(bytes("d4:infod6:lengthi-1e4:name1:aee")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects a path segment that would escape the torrent root", () => {
    const escaping = bytes(
      "d4:infod5:filesld6:lengthi10e4:pathl2:..5:a.xcieee4:name1:cee"
    );
    expect(() => decodeTorrentFiles(escaping)).toThrow(/malformed torrent/i);
  });

  it("reports a null size when length is absent", () => {
    const noLength = bytes("d4:infod5:filesld4:pathl5:a.xcieee4:name1:cee");
    expect(decodeTorrentFiles(noLength)).toEqual([
      { index: 0, name: "c/a.xci", size: null }
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/integrations/prowlarr/metainfo.test.ts`
Expected: FAIL — cannot resolve `@/integrations/prowlarr/metainfo`.

- [ ] **Step 3: Write minimal implementation**

Create `src/integrations/prowlarr/metainfo.ts`:

```ts
import { AppError } from "@/lib/errors";

/** Deeper than any real torrent; shallow enough to stop a nesting bomb. */
const maxDepth = 32;

export interface TorrentFile {
  index: number;
  name: string;
  size: number | null;
}

type Bencode =
  | number
  | Uint8Array
  | Bencode[]
  | Map<string, Bencode>;

function malformed(): never {
  throw new AppError("UNAVAILABLE", 502, "Indexer returned a malformed torrent");
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) malformed();
    return this.bytes[this.offset]!;
  }

  private expect(character: string): void {
    if (String.fromCharCode(this.byte()) !== character) malformed();
    this.offset += 1;
  }

  /** Reads decimal digits (with an optional leading `-`) up to `terminator`. */
  private readNumber(terminator: string): number {
    let text = "";
    for (;;) {
      const character = String.fromCharCode(this.byte());
      this.offset += 1;
      if (character === terminator) break;
      if (!/[-0-9]/.test(character) || text.length > 20) malformed();
      text += character;
    }
    if (text.length === 0) malformed();
    const value = Number(text);
    if (!Number.isSafeInteger(value)) malformed();
    return value;
  }

  read(depth = 0): Bencode {
    if (depth > maxDepth) malformed();
    const marker = String.fromCharCode(this.byte());

    if (marker === "i") {
      this.offset += 1;
      return this.readNumber("e");
    }

    if (marker === "l") {
      this.offset += 1;
      const items: Bencode[] = [];
      while (String.fromCharCode(this.byte()) !== "e") {
        items.push(this.read(depth + 1));
      }
      this.offset += 1;
      return items;
    }

    if (marker === "d") {
      this.offset += 1;
      const entries = new Map<string, Bencode>();
      while (String.fromCharCode(this.byte()) !== "e") {
        const key = this.read(depth + 1);
        if (!(key instanceof Uint8Array)) malformed();
        entries.set(new TextDecoder().decode(key), this.read(depth + 1));
      }
      this.offset += 1;
      return entries;
    }

    if (/[0-9]/.test(marker)) {
      const length = this.readNumber(":");
      if (length < 0 || this.offset + length > this.bytes.length) malformed();
      const slice = this.bytes.subarray(this.offset, this.offset + length);
      this.offset += length;
      return slice;
    }

    return malformed();
  }
}

function asMap(value: Bencode | undefined): Map<string, Bencode> {
  if (!(value instanceof Map)) malformed();
  return value;
}

function asText(value: Bencode | undefined): string {
  if (!(value instanceof Uint8Array)) malformed();
  return new TextDecoder().decode(value);
}

function asSize(value: Bencode | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || value < 0) malformed();
  return value;
}

/**
 * A path segment that is empty, `.`, `..`, or contains a separator would let a
 * hostile torrent render a misleading name. Gamarr never writes these bytes
 * itself — qBittorrent does — but the name is shown to the user and is used to
 * verify the index before priorities are written, so it must be trustworthy.
 */
function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.includes("/")
    || segment.includes("\\")
  ) {
    malformed();
  }
}

export function decodeTorrentFiles(bytes: Uint8Array): TorrentFile[] {
  const reader = new Reader(bytes);
  const root = reader.read();
  if (!(root instanceof Map)) malformed();
  if (reader.position !== bytes.length) malformed();

  const info = asMap(root.get("info"));
  const name = asText(info.get("name"));
  assertSafeSegment(name);

  const files = info.get("files");
  if (files === undefined) {
    return [{ index: 0, name, size: asSize(info.get("length")) }];
  }

  if (!Array.isArray(files)) malformed();
  return files.map((entry, index) => {
    const file = asMap(entry);
    const path = file.get("path");
    if (!Array.isArray(path) || path.length === 0) malformed();
    const segments = path.map((segment) => {
      const text = asText(segment);
      assertSafeSegment(text);
      return text;
    });
    return {
      index,
      name: [name, ...segments].join("/"),
      size: asSize(file.get("length"))
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/integrations/prowlarr/metainfo.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/prowlarr/metainfo.ts src/integrations/prowlarr/metainfo.test.ts
git commit -m "feat(prowlarr): decode torrent metainfo into an ordered file list"
```

---

## Task 3: Feed parser and URL policy

**Files:**
- Create: `src/integrations/prowlarr/feed.ts`, `src/integrations/prowlarr/feed.test.ts`
- Create: `src/integrations/prowlarr/url-policy.ts`, `src/integrations/prowlarr/url-policy.test.ts`
- Read for reference: `src/integrations/newznab/client.ts` (the `parse` method), `src/integrations/newznab/url-policy.ts`, `src/integrations/newznab/url-policy.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // feed.ts
  export interface FeedIndexer {
    id: string;
    name: string;
    protocol: "usenet" | "torrent";
  }
  export interface ParsedFeed {
    releases: FeedRelease[];
    warnings: string[];
  }
  export interface FeedRelease {
    guid: string;
    title: string;
    protocol: "usenet" | "torrent";
    indexerId: string;
    indexerName: string;
    downloadUrl: string;
    magnetUrl: string | null;
    seeders: number | null;
    peers: number | null;
    size: number | null;
    category: string | null;
    publishedAt: number | null;
  }
  export function parseFeed(xml: string, indexer: FeedIndexer, maxItems?: number): ParsedFeed;

  // url-policy.ts — identical API to the newznab original
  export interface SafeDownloadTarget { origin: string; downloadPath: string; }
  export type DownloadUrlRejectionReason =
    | "malformed" | "unsupportedProtocol" | "credentialsOrFragment" | "differentOrigin";
  export class DownloadUrlPolicyError extends AppError {
    readonly reason: DownloadUrlRejectionReason;
  }
  export function validateDownloadUrl(configuredBaseUrl: string, releaseUrl: string): SafeDownloadTarget;
  ```
  Task 5 calls `parseFeed`; Task 9 calls `validateDownloadUrl`.

**Background:** `parseFeed` is the `parse` method of `NewznabClient` lifted into a free function and extended for Torznab. Torznab documents are the same RSS shape and add three things: a `seeders` attribute, a `peers` attribute, and often a `magneturl` attribute. The enclosure `type` may be `application/x-bittorrent`.

`magnetUrl` resolution order: the `magneturl` attribute if present; otherwise the enclosure URL if it starts with `magnet:`; otherwise `null`. When the enclosure URL is a magnet, `downloadUrl` must still be set to that same magnet string so the release is not discarded for a missing enclosure — Task 6 branches on `magnetUrl` before it ever tries an HTTP fetch.

`url-policy.ts` is a verbatim copy of `src/integrations/newznab/url-policy.ts` with only the doc comment's "indexer" wording changed to "Prowlarr". Do not change its behaviour: it already strips `apikey`, `api_key` and `key` from the returned `downloadPath`, which is what keeps the credential out of the candidates table. Copy `src/integrations/newznab/url-policy.test.ts` alongside it and update the import path.

- [ ] **Step 1: Copy the URL policy and its test**

```bash
cp src/integrations/newznab/url-policy.ts src/integrations/prowlarr/url-policy.ts
cp src/integrations/newznab/url-policy.test.ts src/integrations/prowlarr/url-policy.test.ts
```

In both new files, replace `@/integrations/newznab/url-policy` with `@/integrations/prowlarr/url-policy`. In `url-policy.ts`, change the `DownloadUrlPolicyError` doc comment phrase "the indexer API key" to "the Prowlarr API key" and the `differentOrigin` message from `"Download URL leaves the configured indexer origin"` to `"Download URL leaves the configured Prowlarr origin"`, updating the matching assertion in the copied test.

- [ ] **Step 2: Run the copied test to verify it passes**

Run: `pnpm test src/integrations/prowlarr/url-policy.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing feed test**

Create `src/integrations/prowlarr/feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseFeed, type FeedIndexer } from "@/integrations/prowlarr/feed";

const torrentIndexer: FeedIndexer = {
  id: "7",
  name: "1337x",
  protocol: "torrent"
};
const usenetIndexer: FeedIndexer = {
  id: "3",
  name: "NZBgeek",
  protocol: "usenet"
};

function feed(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>${items}</channel>
</rss>`;
}

const torrentItem = `
  <item>
    <title>Metroid Prime (USA)</title>
    <guid>abc123</guid>
    <pubDate>Mon, 04 Aug 2026 10:00:00 +0000</pubDate>
    <enclosure url="http://prowlarr.test/api/v1/indexer/7/download?link=xyz"
               length="734003200" type="application/x-bittorrent" />
    <torznab:attr name="seeders" value="42" />
    <torznab:attr name="peers" value="50" />
    <torznab:attr name="size" value="734003200" />
    <torznab:attr name="category" value="1080" />
  </item>`;

describe("parseFeed", () => {
  it("reads seeders and peers from torznab attributes", () => {
    const { releases } = parseFeed(feed(torrentItem), torrentIndexer);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      guid: "abc123",
      title: "Metroid Prime (USA)",
      protocol: "torrent",
      indexerId: "7",
      indexerName: "1337x",
      seeders: 42,
      peers: 50,
      size: 734003200,
      category: "1080",
      magnetUrl: null
    });
  });

  it("stamps the indexer's protocol onto every release", () => {
    const { releases } = parseFeed(feed(torrentItem), usenetIndexer);
    expect(releases[0]?.protocol).toBe("usenet");
  });

  it("reads a magnet from the magneturl attribute", () => {
    const item = torrentItem.replace(
      "</item>",
      '<torznab:attr name="magneturl" value="magnet:?xt=urn:btih:abc" /></item>'
    );
    const { releases } = parseFeed(feed(item), torrentIndexer);
    expect(releases[0]?.magnetUrl).toBe("magnet:?xt=urn:btih:abc");
  });

  it("falls back to a magnet enclosure URL", () => {
    const item = `
      <item>
        <title>Game</title>
        <guid>m1</guid>
        <enclosure url="magnet:?xt=urn:btih:def" type="application/x-bittorrent" />
      </item>`;
    const { releases } = parseFeed(feed(item), torrentIndexer);
    expect(releases[0]?.magnetUrl).toBe("magnet:?xt=urn:btih:def");
    expect(releases[0]?.downloadUrl).toBe("magnet:?xt=urn:btih:def");
  });

  it("reports null seeders when the attribute is absent", () => {
    const item = torrentItem.replace(/<torznab:attr name="seeders"[^>]*\/>/, "");
    const { releases } = parseFeed(feed(item), torrentIndexer);
    expect(releases[0]?.seeders).toBeNull();
  });

  it("warns and skips an item with no usable download target", () => {
    const item = "<item><title>Broken</title><guid>b1</guid></item>";
    const { releases, warnings } = parseFeed(feed(item), torrentIndexer);
    expect(releases).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("keeps valid siblings when one item is unusable", () => {
    const broken = "<item><title>Broken</title><guid>b1</guid></item>";
    const { releases, warnings } = parseFeed(
      feed(torrentItem + broken),
      torrentIndexer
    );
    expect(releases).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("returns null publishedAt for an unparseable pubDate", () => {
    const item = torrentItem.replace(
      "Mon, 04 Aug 2026 10:00:00 +0000",
      "not a date"
    );
    const { releases } = parseFeed(feed(item), torrentIndexer);
    expect(releases[0]?.publishedAt).toBeNull();
  });

  it("throws on malformed XML", () => {
    expect(() => parseFeed("<rss><channel>", torrentIndexer))
      .toThrow(/malformed/i);
  });

  it("caps the number of items it returns", () => {
    const many = torrentItem.repeat(5);
    const { releases } = parseFeed(feed(many), torrentIndexer, 2);
    expect(releases).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test src/integrations/prowlarr/feed.test.ts`
Expected: FAIL — cannot resolve `@/integrations/prowlarr/feed`.

- [ ] **Step 5: Write the implementation**

Create `src/integrations/prowlarr/feed.ts`. Start from the `parse` method and the `asRecord` / `asText` / `list` helpers in `src/integrations/newznab/client.ts:37-53,160-207` — copy them verbatim — then apply these changes:

1. Make it a free function `parseFeed(xml, indexer, maxItems = 1000)` rather than a method, and run `XMLValidator.validate(xml)` inside it, throwing `new AppError("UNAVAILABLE", 502, "Indexer returned malformed XML")` on failure.
2. Keep the existing `XMLParser` options exactly: `{ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, isArray: (_name, path) => typeof path === "string" && (path.endsWith(".item") || path.endsWith(".attr")) }`. `removeNSPrefix` is what makes `torznab:attr` arrive as `attr`.
3. Resolve the download target before the required-field check:
   ```ts
   const enclosureUrl = typeof enclosure?.["@_url"] === "string"
     ? enclosure["@_url"]
     : null;
   const magnetAttribute = attribute("magneturl");
   const magnetUrl = typeof magnetAttribute === "string" && magnetAttribute.length > 0
     ? magnetAttribute
     : enclosureUrl?.startsWith("magnet:")
       ? enclosureUrl
       : null;
   const downloadUrl = enclosureUrl ?? magnetUrl;
   ```
   The existing guard `if (!item || !title || !guid || !downloadUrl)` then still pushes `"Ignored an indexer result with missing required fields"` and continues.
4. Note that `attribute` is defined *after* the enclosure block in the original; move the `attributes` / `attribute` declarations above the download-target resolution so `magneturl` is readable there.
5. Add a numeric attribute helper and use it for seeders and peers:
   ```ts
   function numericAttribute(value: unknown): number | null {
     const parsed = Number(value);
     return value !== undefined && Number.isFinite(parsed) ? parsed : null;
   }
   ```
6. Replace `source: "newznab"` with `protocol: indexer.protocol`, and add `magnetUrl`, `seeders: numericAttribute(attribute("seeders"))`, `peers: numericAttribute(attribute("peers"))`.
7. Keep the `publishedAt` comment and its `null`-not-`0` behaviour verbatim.

Export the `FeedIndexer`, `FeedRelease` and `ParsedFeed` interfaces exactly as given in the Interfaces block above.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test src/integrations/prowlarr/feed.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Typecheck, lint, full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean. The newznab modules still exist and still pass — that is intended until Task 14.

- [ ] **Step 8: Commit**

```bash
git add src/integrations/prowlarr/
git commit -m "feat(prowlarr): parse torznab feeds and carry the URL policy across"
```

---

## Task 4: Schema and migration 0006

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0006_*.sql` (generated, then hand-edited)
- Create: `src/db/migration-0006.test.ts`
- Read for reference: `drizzle/0004_superb_impossible_man.sql` (a prior table rebuild), `scripts/migrate.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: tables `prowlarr_settings` and `platform_categories`; `release_candidates` and `download_attempts` rebuilt as described below. Tasks 8–11 depend on these columns existing.

**Background:** `indexers` is referenced by three dependents — `platform_indexer_categories` (cascade), `release_candidates.indexer_id` (cascade), and `download_attempts.indexer_id` (set null). All three must be handled before `indexers` can be dropped. `download_attempts` holds real download history that has already survived two prior migrations; the rebuild must preserve every row.

`pnpm db:generate` will produce a first draft, but Drizzle cannot infer the `platform_indexer_categories` → `platform_categories` data copy or the ordering constraints. Hand-edit the generated file.

- [ ] **Step 1: Update the Drizzle schema**

In `src/db/schema.ts`:

1. Add `prowlarrSettings`, shaped like the existing `sabnzbdSettings` singleton:
   ```ts
   export const prowlarrSettings = sqliteTable(
     "prowlarr_settings",
     {
       id: integer("id").primaryKey().default(1),
       baseUrl: text("base_url").notNull(),
       apiKey: text("api_key").notNull(),
       timeoutMs: integer("timeout_ms").notNull().default(10_000),
       lastTestStatus: text("last_test_status"),
       lastTestedAt: integer("last_tested_at"),
       configRevision: integer("config_revision").notNull().default(1),
       updatedAt: integer("updated_at").notNull()
     },
     (table) => [
       check("prowlarr_singleton", sql`${table.id} = 1`),
       check(
         "prowlarr_timeout_range",
         sql`${table.timeoutMs} between 1000 and 30000`
       )
     ]
   );
   ```
   Match the `id`/singleton convention the existing `sabnzbd_settings` table already uses — read it first and copy that convention exactly rather than the sketch above if they differ.
2. Add `platformCategories`:
   ```ts
   export const platformCategories = sqliteTable(
     "platform_categories",
     {
       platformId: integer("platform_id")
         .notNull()
         .references(() => platforms.id, { onDelete: "cascade" }),
       categoryId: text("category_id").notNull()
     },
     (table) => [primaryKey({ columns: [table.platformId, table.categoryId] })]
   );
   ```
3. In `releaseCandidates`: delete the `source` column and the `release_candidates_source_valid` check; change `indexerId` to `text("indexer_id")` with no `.references(...)`; add `protocol: text("protocol").notNull()` and `seeders: integer("seeders")`; add a check `release_candidates_protocol_valid` over `sql\`${table.protocol} in ('usenet', 'torrent')\``.
4. In `downloadAttempts`: change `indexerId` to `text("indexer_id")` with no `.references(...)`; add `selectedFiles: text("selected_files")` and `filesAppliedAt: integer("files_applied_at")`; add a check `download_attempts_source_valid` over `sql\`${table.source} in ('prowlarr-usenet', 'prowlarr-torrent', 'newznab', 'internet-archive', 'internet-archive-torrent')\``. Leave `iaFileName` and `sabMarker` columns exactly as they are.
5. Delete the `platformIndexerCategories` and `indexers` table declarations.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0006_*.sql` appears. Do not run it yet.

- [ ] **Step 3: Hand-edit the migration into the required order**

Open the generated file and rewrite it so the statements run in exactly this order. Wrap the whole file in `PRAGMA foreign_keys=OFF;` … `PRAGMA foreign_keys=ON;` (Drizzle emits this for rebuilds; make sure it spans every statement below).

1. `CREATE TABLE prowlarr_settings (…)`.
2. `CREATE TABLE platform_categories (…)`.
3. Data copy — Drizzle will not have generated this, add it verbatim:
   ```sql
   INSERT INTO platform_categories (platform_id, category_id)
   SELECT DISTINCT platform_id, category_id FROM platform_indexer_categories;
   ```
4. The `release_candidates` rebuild. It is a 30-minute TTL cache, so it is created empty — delete any `INSERT INTO __new_release_candidates SELECT …` statement Drizzle generated for it.
5. The `download_attempts` rebuild. **Every row must be preserved.** Verify the generated `INSERT INTO __new_download_attempts (…) SELECT … FROM download_attempts;` names every retained column explicitly and that `selected_files` and `files_applied_at` are absent from the column list so they default to `NULL`.
6. `DROP TABLE platform_indexer_categories;`
7. `DROP TABLE indexers;`

- [ ] **Step 4: Write the migration test**

Create `src/db/migration-0006.test.ts`. It must build a database at the pre-0006 state, seed it, run the migrator, and assert preservation. Use the same mechanism `scripts/migrate.mjs` uses — read that file and reuse its migrator invocation against a temp file path from the scratch directory.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "gamarr-migration-"));
  databasePath = join(directory, "gamarr.db");
  applied = new Set();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Tags already applied to the current temp database. Reset per test. */
let applied: Set<string>;

/**
 * Applies not-yet-applied migrations in journal order, stopping after
 * `through` (inclusive). Resumable on purpose: a test seeds at 0005, then
 * calls this again for 0006, and replaying 0000 would fail on
 * "table download_attempts already exists".
 */
function applyMigrations(through: string): void {
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> };
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  for (const entry of journal.entries) {
    if (!applied.has(entry.tag)) {
      const sql = readFileSync(
        join(process.cwd(), "drizzle", `${entry.tag}.sql`),
        "utf8"
      );
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) database.exec(trimmed);
      }
      applied.add(entry.tag);
    }
    if (entry.tag.startsWith(through)) break;
  }
  database.close();
}

function open(): Database.Database {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  return database;
}

const legacySources = [
  "newznab",
  "internet-archive",
  "internet-archive-torrent"
] as const;

function seedAttempts(): void {
  const database = open();
  database.exec(`
    INSERT INTO platforms (id, name, visible) VALUES (1, 'Switch', 1);
    INSERT INTO games (id, name) VALUES (1, 'Metroid Prime');
    INSERT INTO library_entries (id, game_id, platform_id, created_at, updated_at)
      VALUES ('lib-1', 1, 1, 1000, 1000);
  `);
  const insert = database.prepare(`
    INSERT INTO download_attempts (
      id, library_entry_id, submission_key, request_fingerprint, status, source,
      release_title, indexer_name_snapshot, sabnzbd_config_revision, sab_marker,
      progress, created_at, updated_at, completed_at
    ) VALUES (?, 'lib-1', ?, ?, ?, ?, ?, ?, 1, ?, ?, 1000, 2000, ?)
  `);
  legacySources.forEach((source, index) => {
    insert.run(
      `attempt-${index}`,
      `key-${index}`,
      `fingerprint-${index}`,
      index === 0 ? "Completed" : "Downloading",
      source,
      `Release ${index}`,
      `Indexer ${index}`,
      `marker-${index}`,
      index * 10,
      index === 0 ? 3000 : null
    );
  });
  database.close();
}

const preservedColumns = [
  "id", "source", "status", "release_title", "indexer_name_snapshot",
  "sab_marker", "progress", "created_at", "completed_at"
].join(", ");

describe("migration 0006", () => {
  it("preserves every download attempt across the rebuild", () => {
    applyMigrations("0005");
    seedAttempts();

    const before = open();
    const expected = before
      .prepare(`SELECT ${preservedColumns} FROM download_attempts ORDER BY id`)
      .all();
    before.close();
    expect(expected).toHaveLength(3);

    applyMigrations("0006");

    const after = open();
    const actual = after
      .prepare(`SELECT ${preservedColumns} FROM download_attempts ORDER BY id`)
      .all();
    const blanks = after
      .prepare(
        "SELECT selected_files, files_applied_at FROM download_attempts"
      )
      .all() as Array<{ selected_files: unknown; files_applied_at: unknown }>;
    after.close();

    expect(actual).toEqual(expected);
    for (const row of blanks) {
      expect(row.selected_files).toBeNull();
      expect(row.files_applied_at).toBeNull();
    }
  });

  it("folds platform indexer categories into platform categories", () => {
    applyMigrations("0005");
    const seed = open();
    seed.exec(`
      INSERT INTO platforms (id, name, visible) VALUES (1, 'Switch', 1);
      INSERT INTO indexers (
        id, name, base_url, api_key, enabled, timeout_ms,
        config_revision, created_at, updated_at
      ) VALUES
        ('a', 'A', 'http://a.test/api', 'k', 1, 10000, 1, 1000, 1000),
        ('b', 'B', 'http://b.test/api', 'k', 1, 10000, 1, 1000, 1000);
      INSERT INTO platform_indexer_categories (platform_id, indexer_id, category_id)
        VALUES (1, 'a', '1080'), (1, 'b', '1080'), (1, 'a', '4000');
    `);
    seed.close();

    applyMigrations("0006");

    const database = open();
    const rows = database
      .prepare(
        "SELECT category_id FROM platform_categories WHERE platform_id = 1"
        + " ORDER BY category_id"
      )
      .all() as Array<{ category_id: string }>;
    database.close();
    expect(rows.map((row) => row.category_id)).toEqual(["1080", "4000"]);
  });

  it("drops the indexers table", () => {
    applyMigrations("0006");
    const database = open();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    database.close();
    expect(names).not.toContain("indexers");
    expect(names).not.toContain("platform_indexer_categories");
    expect(names).toContain("prowlarr_settings");
    expect(names).toContain("platform_categories");
  });
});
```

Add `import { readFileSync } from "node:fs";` to the imports. The seed statements above name columns that must match the real pre-0006 schema — read `drizzle/0000_eminent_true_believers.sql` and the later migrations first and adjust the `INSERT` column lists to whatever those files actually declare, including any `NOT NULL` column not listed here.

- [ ] **Step 5: Run the migration test**

Run: `pnpm test src/db/migration-0006.test.ts`
Expected: PASS, 3 tests. If the `download_attempts` assertion fails, the rebuild's `INSERT … SELECT` column list is wrong — fix the migration, never the test.

- [ ] **Step 6: Apply against a scratch database and typecheck**

```bash
GAMARR_DATABASE_PATH=./data/scratch-0006.db pnpm db:migrate
pnpm typecheck
rm -f ./data/scratch-0006.db*
```
Expected: migration applies cleanly; typecheck fails only in files that still reference the deleted `indexers` / `platformIndexerCategories` exports. Those are fixed in Tasks 8–12 — record the failing file list in the commit message and proceed.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle/ src/db/migration-0006.test.ts
git commit -m "feat(db): add prowlarr settings and platform categories, retire indexers"
```

---

## Task 5: Prowlarr client

**Files:**
- Create: `src/integrations/prowlarr/client.ts`, `src/integrations/prowlarr/client.test.ts`
- Read for reference: `src/integrations/newznab/client.ts` (fetch/bounding shape), `src/integrations/read-bounded-response.ts`

**Interfaces:**
- Consumes: `parseFeed`, `FeedIndexer`, `FeedRelease` from Task 3 (`@/integrations/prowlarr/feed`).
- Produces:
  ```ts
  export interface ProwlarrIndexer {
    id: string;
    name: string;
    protocol: "usenet" | "torrent";
    priority: number;
    categoryIds: string[];
  }
  export interface ProwlarrClientOptions {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    fetch?: typeof fetch;
    maxResponseBytes?: number;
    maxItems?: number;
  }
  export class ProwlarrClient {
    listIndexers(signal?: AbortSignal): Promise<ProwlarrIndexer[]>;
    search(
      indexer: ProwlarrIndexer,
      query: { term: string; categories: string[] },
      signal?: AbortSignal
    ): Promise<{ releases: FeedRelease[]; warnings: string[] }>;
  }
  ```
  Task 9 wires this to the `ProwlarrPort` interface it declares.

**Background:**
- Discovery: `GET {baseUrl}/api/v1/indexer` with header `X-Api-Key`. Parse with Zod; keep only entries where `enable === true`. Map `capabilities.categories[].id` (numbers) to `categoryIds` (strings). Reject anything whose `protocol` is neither `"usenet"` nor `"torrent"` by filtering it out rather than throwing — an unknown protocol is one indexer Gamarr cannot use, not a broken Prowlarr.
- Search: `GET {baseUrl}/api/v1/indexer/{id}/newznab?t=search&q=…&cat=…&o=xml`, again with the `X-Api-Key` header. Omit `cat` entirely when `query.categories` is empty.
- Both requests: `redirect: "manual"`, bounded by `readBoundedResponse`, combined `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`. Non-`ok` responses throw `AppError("UNAVAILABLE", 502, …)` with a fixed message — never interpolate an upstream body.

- [ ] **Step 1: Write the failing test**

Create `src/integrations/prowlarr/client.test.ts` with a `fetch` fake injected through options. Cover, at minimum:

```ts
it("sends the API key as a header, never in the URL", async () => {
  // Assert the recorded Request URL contains neither "apikey" nor the key,
  // and that headers.get("X-Api-Key") equals the configured key.
});

it("returns only enabled indexers", async () => {
  // Feed a payload with one enable:true and one enable:false entry.
});

it("maps capability category ids to strings", async () => {
  // capabilities.categories: [{id: 1080, name: "Console"}] -> ["1080"]
});

it("skips indexers with an unrecognised protocol", async () => {
  // protocol: "carrier-pigeon" is filtered out, the sibling survives.
});

it("throws UNAVAILABLE when discovery returns a non-ok status", async () => {});

it("throws UNAVAILABLE when the discovery payload fails validation", async () => {});

it("queries the per-indexer newznab endpoint with the search term", async () => {
  // URL is `${base}/api/v1/indexer/7/newznab` with t=search, q, o=xml.
});

it("omits the cat parameter when no categories are supplied", async () => {});

it("joins supplied categories with commas", async () => {});

it("throws UNAVAILABLE when a search response exceeds the byte cap", async () => {});

it("propagates an external abort signal", async () => {});
```

Write each body out in full — inject a `fetch` fake that records the `Request` (or `URL` + `RequestInit`) it receives and returns a `Response` built from a fixture string.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/integrations/prowlarr/client.test.ts`
Expected: FAIL — cannot resolve `@/integrations/prowlarr/client`.

- [ ] **Step 3: Write the implementation**

Create `src/integrations/prowlarr/client.ts`:

```ts
import { z } from "zod";

import {
  parseFeed,
  type FeedRelease
} from "@/integrations/prowlarr/feed";
import { readBoundedResponse } from "@/integrations/read-bounded-response";
import { AppError } from "@/lib/errors";

const indexerSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  protocol: z.string(),
  enable: z.boolean().optional().default(true),
  priority: z.number().optional().default(25),
  capabilities: z
    .object({
      categories: z
        .array(z.object({ id: z.union([z.number(), z.string()]) }))
        .optional()
        .default([])
    })
    .optional()
    .default({ categories: [] })
});

export interface ProwlarrIndexer {
  id: string;
  name: string;
  protocol: "usenet" | "torrent";
  priority: number;
  categoryIds: string[];
}

export interface ProwlarrClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  maxItems?: number;
}

export class ProwlarrClient {
  private readonly request: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxItems: number;

  constructor(private readonly options: ProwlarrClientOptions) {
    this.request = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxItems = options.maxItems ?? 1_000;
  }

  async listIndexers(signal?: AbortSignal): Promise<ProwlarrIndexer[]> {
    const url = this.apiUrl("api/v1/indexer");
    const body = await this.fetchBounded(url, "indexer list", signal, "json");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new AppError("UNAVAILABLE", 502, "Prowlarr returned invalid JSON");
    }
    const parsed = z.array(indexerSchema).safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr returned an invalid indexer list"
      );
    }
    return parsed.data
      .filter((entry) => entry.enable)
      .filter((entry) => entry.protocol === "usenet" || entry.protocol === "torrent")
      .map((entry) => ({
        id: String(entry.id),
        name: entry.name,
        protocol: entry.protocol as "usenet" | "torrent",
        priority: entry.priority,
        categoryIds: entry.capabilities.categories.map((category) =>
          String(category.id))
      }));
  }

  async search(
    indexer: ProwlarrIndexer,
    query: { term: string; categories: string[] },
    signal?: AbortSignal
  ): Promise<{ releases: FeedRelease[]; warnings: string[] }> {
    const url = this.apiUrl(`api/v1/indexer/${encodeURIComponent(indexer.id)}/newznab`);
    url.searchParams.set("t", "search");
    url.searchParams.set("q", query.term);
    url.searchParams.set("o", "xml");
    if (query.categories.length > 0) {
      url.searchParams.set("cat", query.categories.join(","));
    }
    const xml = await this.fetchBounded(url, "search", signal, "xml");
    return parseFeed(
      xml,
      { id: indexer.id, name: indexer.name, protocol: indexer.protocol },
      this.maxItems
    );
  }

  private apiUrl(path: string): URL {
    const url = new URL(this.options.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
    url.search = "";
    url.hash = "";
    return url;
  }

  private async fetchBounded(
    url: URL,
    operation: string,
    signal: AbortSignal | undefined,
    kind: "json" | "xml"
  ): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const response = await this.request(url, {
      // The key travels as a header so it never enters a URL Gamarr builds,
      // which is what keeps it out of logs and error paths.
      headers: {
        "x-api-key": this.options.apiKey,
        accept: kind === "json"
          ? "application/json"
          : "application/rss+xml, application/xml, text/xml"
      },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    });
    if (!response.ok) {
      throw new AppError("UNAVAILABLE", 502, `Prowlarr ${operation} failed`);
    }
    const bytes = await readBoundedResponse(
      response,
      this.maxResponseBytes,
      () => new AppError(
        "UNAVAILABLE",
        502,
        `Prowlarr ${operation} response is too large`
      )
    );
    return new TextDecoder().decode(bytes);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/integrations/prowlarr/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean apart from the Task 4 fallout already recorded.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/prowlarr/client.ts src/integrations/prowlarr/client.test.ts
git commit -m "feat(prowlarr): discover indexers and search them individually"
```

---

## Task 6: Release fetcher with magnet fallback

**Files:**
- Create: `src/integrations/prowlarr/fetch.ts`, `src/integrations/prowlarr/fetch.test.ts`
- Read for reference: `src/integrations/newznab/download.ts` — **the whole file**. This task is a port of it.

**Interfaces:**
- Consumes: `validateMagnet` (Task 1), `validateDownloadUrl` (Task 3).
- Produces:
  ```ts
  export type FetchedRelease =
    | { kind: "nzb"; bytes: Uint8Array }
    | { kind: "torrent"; bytes: Uint8Array }
    | { kind: "magnet"; uri: string };
  export interface ProwlarrFetcherOptions {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    fetch?: typeof fetch;
    lookup?: (hostname: string) => Promise<string[]>;
  }
  export class ProwlarrFetcher {
    fetch(input: {
      protocol: "usenet" | "torrent";
      downloadPath: string;
      magnetUrl: string | null;
      maxBytes: number;
    }): Promise<FetchedRelease>;
  }
  ```
  Task 10 injects this as `ReleaseFetcherPort`.

**Background:** `src/integrations/newznab/download.ts` already implements everything hard here: a manual redirect chain bounded at 3 hops, a single approved external-origin handoff, DNS resolution with socket pinning, rejection of non-public addresses, and `removeIndexerCredentials`, which rejects any redirect whose path or query echoes the configured API key. Port that file wholesale and add exactly two behaviours:

1. **Short circuit on a feed-supplied magnet.** If `input.magnetUrl` is non-null, return `{ kind: "magnet", uri: validateMagnet(input.magnetUrl, apiKey) }` and make no HTTP request at all.
2. **Magnet as a redirect terminal.** When a hop returns a 3xx whose `Location` starts with `magnet:`, stop following, run `validateMagnet(location, apiKey)`, and return `{ kind: "magnet", uri }`. This check must come **before** the existing `new URL(location, target)` resolution, because a magnet is not resolvable against an http base in a meaningful way.

The returned `kind` for a successful body read is `"torrent"` when `input.protocol === "torrent"`, `"nzb"` otherwise. Do not sniff the content type to decide — Prowlarr's proxy is not consistent about it, and the indexer's declared protocol is authoritative.

Rename the user-facing messages from "Indexer …" to "Prowlarr …" (e.g. `"Prowlarr returned an unsafe redirect"`), since there is now one upstream.

- [ ] **Step 1: Write the failing test**

Create `src/integrations/prowlarr/fetch.test.ts`. Port the existing cases from `src/integrations/newznab/download.test.ts` — read that file and carry every case across, renaming messages — then add:

```ts
it("returns a feed-supplied magnet without making a request", async () => {
  // fetch fake throws if called; assert kind === "magnet".
});

it("returns a magnet from a redirect Location", async () => {
  // 302 with Location: magnet:?xt=urn:btih:<40 hex>
});

it("rejects a redirect magnet that echoes the API key", async () => {
  // 302 to a magnet whose tr= contains the key -> throws, key absent from message.
});

it("rejects a feed-supplied magnet with a non-btih topic", async () => {});

it("labels a torrent-protocol body as kind torrent", async () => {});

it("labels a usenet-protocol body as kind nzb", async () => {});

it("rejects a body larger than maxBytes", async () => {});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/integrations/prowlarr/fetch.test.ts`
Expected: FAIL — cannot resolve `@/integrations/prowlarr/fetch`.

- [ ] **Step 3: Port the implementation**

```bash
cp src/integrations/newznab/download.ts src/integrations/prowlarr/fetch.ts
```

Then, in `src/integrations/prowlarr/fetch.ts`:
- Rename the class to `ProwlarrFetcher` and change its options to `ProwlarrFetcherOptions` (drop the `indexer: IndexerRecord` parameter threading — `baseUrl` and `apiKey` come from constructor options now).
- Change the import of `validateDownloadUrl` to `@/integrations/prowlarr/url-policy`.
- Add `import { validateMagnet } from "@/integrations/prowlarr/magnet-policy";`.
- Add the two magnet behaviours described above.
- Change the return type from `Uint8Array` to `FetchedRelease` and tag it from `input.protocol`.
- Replace "Indexer" with "Prowlarr" in every user-facing message string.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/integrations/prowlarr/fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**

```bash
git add src/integrations/prowlarr/fetch.ts src/integrations/prowlarr/fetch.test.ts
git commit -m "feat(prowlarr): fetch release payloads with a magnet fallback"
```

---

## Task 7: qBittorrent magnet, file listing and priorities

**Files:**
- Modify: `src/integrations/qbittorrent/client.ts`, `src/integrations/qbittorrent/client.test.ts`
- Modify: `src/features/downloads/port.ts` (the `TorrentClientPort` interface only)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, on `TorrentClientPort`:
  ```ts
  add(input: {
    payload: { torrent: Uint8Array; filename: string } | { magnet: string };
    category: string | null;
    tag: string;
  }): Promise<{ hash: string | null }>;
  listFiles(hash: string): Promise<Array<{ index: number; name: string }>>;
  setFilePriorities(hash: string, indices: number[], priority: 0): Promise<void>;
  ```
  `list()` and `testConnection()` are unchanged. Task 11 calls `listFiles` and `setFilePriorities`.

**Background:** `add` currently takes `torrent: Uint8Array` and `filename: string` directly (`src/integrations/qbittorrent/client.ts:59-64`). Widen it to the discriminated `payload`. For a magnet, set the form field `urls` to the magnet string instead of setting `torrents`; everything else — `tags`, `category`, the `TorrentAddError` outcome mapping, the bare-`Ok.` hash fallback — stays exactly as it is.

`torrents/files?hash=…` returns an array of objects with a `name` (path relative to the torrent root, including the root directory for multi-file torrents) and an `index` on WebAPI ≥ 2.8.2. Older builds omit `index`, in which case array position is the index — fall back to position.

`torrents/filePrio` is a POST with `hash`, `id` (a `|`-separated list of indices) and `priority`. An empty `indices` array must make no request at all.

- [ ] **Step 1: Write the failing tests**

Add to `src/integrations/qbittorrent/client.test.ts`:

```ts
it("submits a magnet through the urls field", async () => {
  // Assert the posted FormData has urls === magnet and no torrents part.
});

it("still submits torrent bytes as a file part", async () => {
  // Existing behaviour, re-expressed through the new payload shape.
});

it("lists files with their indices", async () => {
  // [{name: "a", index: 0}, {name: "b", index: 1}] round-trips.
});

it("falls back to array position when index is absent", async () => {
  // [{name: "a"}, {name: "b"}] -> indices 0 and 1.
});

it("returns an empty list when metadata has not arrived", async () => {
  // [] -> [].
});

it("throws UNAVAILABLE when the file list is invalid", async () => {});

it("posts a pipe-separated id list to filePrio", async () => {
  // setFilePriorities("h", [1, 3], 0) -> body id === "1|3", priority === "0".
});

it("makes no request when the index list is empty", async () => {
  // fetch fake throws if called.
});
```

Also update every existing `add(...)` call in this test file to the new `payload` shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/integrations/qbittorrent/client.test.ts`
Expected: FAIL — `payload` is not a known property, `listFiles` is not a function.

- [ ] **Step 3: Update the port**

In `src/features/downloads/port.ts`, replace the `add` signature on `TorrentClientPort` with the one in the Interfaces block above and add `listFiles` and `setFilePriorities`. Keep the existing doc comment on `list()` about the single-value `tag=` filter, and keep the `TorrentAddError` / `TorrentAddOutcome` declarations untouched.

- [ ] **Step 4: Implement in the client**

In `src/integrations/qbittorrent/client.ts`:

```ts
async add(input: {
  payload: { torrent: Uint8Array; filename: string } | { magnet: string };
  category: string | null;
  tag: string;
}): Promise<{ hash: string | null }> {
  const form = new FormData();
  if ("magnet" in input.payload) {
    form.set("urls", input.payload.magnet);
  } else {
    form.set(
      "torrents",
      new Blob([new Uint8Array(input.payload.torrent)], {
        type: "application/x-bittorrent"
      }),
      input.payload.filename
    );
  }
  form.set("tags", input.tag);
  if (input.category !== null) form.set("category", input.category);
  // …the rest of the existing method body is unchanged from here down.
}
```

Add the two new methods:

```ts
async listFiles(hash: string): Promise<Array<{ index: number; name: string }>> {
  const search = new URLSearchParams({ hash });
  let response: Response;
  try {
    response = await this.authenticatedRequest(
      `torrents/files?${search.toString()}`,
      { headers: { accept: "application/json" } }
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("UNAVAILABLE", 502, "qBittorrent file list request failed");
  }
  if (!response.ok) {
    await discardBody(response);
    throw new AppError("UNAVAILABLE", 502, "qBittorrent file list request failed");
  }
  let payload: unknown;
  try {
    payload = await readBoundedJson(
      response,
      this.maxResponseBytes,
      () => new AppError(
        "UNAVAILABLE",
        502,
        "qBittorrent file list response is too large"
      )
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("UNAVAILABLE", 502, "qBittorrent returned an invalid file list");
  }
  const parsed = z
    .array(z.object({ name: z.string().min(1), index: z.number().optional() }))
    .safeParse(payload);
  if (!parsed.success) {
    throw new AppError("UNAVAILABLE", 502, "qBittorrent returned an invalid file list");
  }
  // WebAPI builds before 2.8.2 omit `index`; array position is the index there,
  // and it is the same order the metainfo declares.
  return parsed.data.map((file, position) => ({
    index: file.index ?? position,
    name: file.name
  }));
}

async setFilePriorities(
  hash: string,
  indices: number[],
  priority: 0
): Promise<void> {
  if (indices.length === 0) return;
  const form = new URLSearchParams({
    hash,
    id: indices.join("|"),
    priority: String(priority)
  });
  let response: Response;
  try {
    response = await this.authenticatedRequest("torrents/filePrio", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("UNAVAILABLE", 502, "qBittorrent file priority request failed");
  }
  await discardBody(response);
  if (!response.ok) {
    throw new AppError("UNAVAILABLE", 502, "qBittorrent file priority request failed");
  }
}
```

- [ ] **Step 5: Update the one existing caller so the build stays green**

`src/features/downloads/service.ts` calls `client.add({ torrent: bytes, filename: torrent.name, … })` around line 425. Change it to `client.add({ payload: { torrent: bytes, filename: torrent.name }, … })`. This is a temporary shim — Task 10 rewrites the surrounding method.

- [ ] **Step 6: Run tests**

Run: `pnpm test src/integrations/qbittorrent/ && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/qbittorrent/ src/features/downloads/port.ts src/features/downloads/service.ts
git commit -m "feat(qbittorrent): accept magnets and control per-file priorities"
```

---

## Task 8: Prowlarr settings

**Files:**
- Modify: `src/features/settings/models.ts`, `repository.ts`, `service.ts`, and their tests
- Modify: `src/features/catalog/repository.ts` (platform category read)

**Interfaces:**
- Consumes: Task 4's `prowlarrSettings` and `platformCategories` tables.
- Produces:
  ```ts
  export const prowlarrSettingsInputSchema: z.ZodType<{
    baseUrl: string;
    apiKey: SecretUpdate;
    timeoutMs: number;
  }>;
  export type ProwlarrSettingsInput = z.infer<typeof prowlarrSettingsInputSchema>;
  export interface ProwlarrSettingsRecord {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    lastTestStatus: string | null;
    lastTestedAt: number | null;
    configRevision: number;
    updatedAt: number;
  }
  export interface PublicProwlarrSettings {
    baseUrl: string;
    hasApiKey: boolean;
    timeoutMs: number;
    lastTestStatus: string | null;
    lastTestedAt: number | null;
    configRevision: number;
  }
  // On SqliteSettingsRepository:
  getProwlarr(): ProwlarrSettingsRecord | null;
  saveProwlarr(value: ProwlarrSettingsRecord): void;
  recordProwlarrTest(status: string, testedAt: number): void;
  listPlatformCategories(platformId: number): string[];
  savePlatformCategories(platformId: number, categoryIds: string[]): void;
  ```
  `PublicSettings.indexers` becomes `PublicSettings.prowlarr: PublicProwlarrSettings | null`. Tasks 12 and 13 consume these.

**Background:** Model the new record on the existing `sabnzbd` and `qbittorrent` trio (`getSabnzbd` / `saveSabnzbd` / `recordSabnzbdTest` at `src/features/settings/repository.ts:56-92`) — read those and follow the same shape, including how `configRevision` is bumped on save and how the secret `retain` action preserves the stored value.

Delete `indexerInputSchema`, `IndexerInput`, `IndexerRecord`, `PublicIndexer`, `listIndexers`, `saveIndexer`, `deleteIndexer`, `recordIndexerTest`, and the `SettingsService.saveIndexer` / `deleteIndexer` methods.

`src/features/catalog/repository.ts:44` currently reads `settings?.categoryIds ?? []` for a platform. Repoint it at `listPlatformCategories(platformId)`.

- [ ] **Step 1: Write failing repository tests**

In `src/features/settings/repository.test.ts`, delete the indexer cases (including the one seeding `baseUrl: "http://prowlarr.local/1/api"` around line 103) and add:

```ts
it("round-trips prowlarr settings", () => {});
it("returns null when prowlarr is unconfigured", () => {});
it("bumps configRevision on save", () => {});
it("records a connection test without touching the credential", () => {});
it("replaces a platform's categories wholesale", () => {});
it("returns an empty category list for an unknown platform", () => {});
```

Write each body in full, following the existing sabnzbd cases as a template.

- [ ] **Step 2: Write failing service tests**

In `src/features/settings/service.test.ts`, delete the indexer cases and add:

```ts
it("redacts the prowlarr api key", () => {
  // getRedacted().prowlarr?.hasApiKey === true, and no property holds the value.
});
it("retains the stored api key on a retain action", () => {});
it("clears the api key on a clear action", () => {});
it("rejects a non-URL base url", () => {});
it("rejects a timeout outside 1000..30000", () => {});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/features/settings/`
Expected: FAIL.

- [ ] **Step 4: Implement models, repository and service**

Apply the deletions and additions described above. In `SettingsService.getRedacted`, replace the `indexers: …` mapping with `prowlarr: record === null ? null : { baseUrl, hasApiKey: record.apiKey.length > 0, timeoutMs, lastTestStatus, lastTestedAt, configRevision }`.

- [ ] **Step 5: Repoint the catalog repository**

In `src/features/catalog/repository.ts`, replace the `settings?.categoryIds ?? []` read with a `listPlatformCategories(platformId)` call and drop the now-unused settings lookup if nothing else needs it. Update `src/features/catalog/repository.test.ts` accordingly.

- [ ] **Step 6: Run tests**

Run: `pnpm test src/features/settings/ src/features/catalog/ && pnpm typecheck`
Expected: settings and catalog PASS. `typecheck` still fails in `release-search`, `downloads` and `src/app/api/**` — those are Tasks 9–12.

- [ ] **Step 7: Commit**

```bash
git add src/features/settings/ src/features/catalog/
git commit -m "feat(settings): replace the indexer list with a Prowlarr connection"
```

---

## Task 9: Release search over Prowlarr

**Files:**
- Modify: `src/features/release-search/models.ts`, `ports.ts`, `service.ts`, `repository.ts`, `file-selection.ts`, and their tests

**Interfaces:**
- Consumes: `ProwlarrClient` (Task 5), `validateDownloadUrl` (Task 3), `decodeTorrentFiles` + `TorrentFile` (Task 2), `listPlatformCategories` (Task 8).
- Produces:
  ```ts
  // models.ts
  export interface Release {
    guid: string;
    title: string;
    protocol: "usenet" | "torrent";
    indexerId: string;
    indexerName: string;
    downloadUrl: string;
    magnetUrl: string | null;
    seeders: number | null;
    peers: number | null;
    size: number | null;
    category: string | null;
    publishedAt: number | null;
  }
  // ports.ts
  export interface ProwlarrIndexerSummary {
    id: string; name: string;
    protocol: "usenet" | "torrent";
    priority: number; categoryIds: string[];
  }
  export interface ProwlarrPort {
    listIndexers(signal: AbortSignal): Promise<ProwlarrIndexerSummary[]>;
    search(
      indexer: ProwlarrIndexerSummary,
      query: PlannedQuery,
      signal: AbortSignal
    ): Promise<{ releases: Release[]; warnings: string[] }>;
  }
  export interface ReleaseCandidateRecord {
    id: string; expiresAt: number;
    protocol: "usenet" | "torrent";
    indexerId: string; indexerConfigRevision: number;
    guid: string; title: string;
    size: number | null; seeders: number | null;
    downloadPath: string; category: string | null;
    sourceSnapshot: string; createdAt: number;
  }
  // service.ts
  export interface PublicReleaseSource {
    candidateId: string; indexerName: string;
    protocol: "usenet" | "torrent"; seeders: number | null;
  }
  export interface ReleaseSearchResponse {
    releases: PublicRelease[];
    warnings: Array<{ indexerId: string; indexerName: string; message: string }>;
    usenetClientConfigured: boolean;
    torrentClientConfigured: boolean;
  }
  export interface CandidateFilesResponse {
    files: TorrentFile[];
    metadataPending: boolean;
  }
  ```
  Tasks 10, 12 and 13 consume these.

**Background:** Delete from `models.ts`: `ReleaseSourceType`, `INTERNET_ARCHIVE_INDEXER_ID`, `INTERNET_ARCHIVE_INDEXER_NAME`, `NewznabSearchResult`, `InternetArchiveItem`, `InternetArchiveFile`, `InternetArchiveSearchResult`, `ItemTorrent`. Delete from `ports.ts`: `NewznabPort`, `NewznabClientFactory`, `ListReleaseIndexersPort`, `InternetArchiveSearchPort`, `TorrentClientConfiguredPort`.

**Two deliberate duplications, both required by the architecture — do not "fix" them by importing across the boundary:**

- `ProwlarrPort` / `ProwlarrIndexerSummary` / `Release` here are declared field-for-field identical to `ProwlarrClient` / `ProwlarrIndexer` / `FeedRelease` in Tasks 3 and 5. A feature may not import an integration's types, so `ProwlarrClient` satisfies `ProwlarrPort` structurally rather than nominally. If you change a field in one, change it in both or the composition root in Task 12 stops compiling.
- `metainfo.ts` *is* imported directly by this feature. That is allowed: `CLAUDE.md` carves out pure validation modules with no I/O, which is exactly what `metainfo.ts` is, and it is the same exception `newznab/url-policy` already relied on. Note it in a comment at the import site so a reviewer does not flag it.

**Persisting the magnet.** Only torrent candidates have a `magnetUrl`, so it rides in the existing `sourceSnapshot` JSON rather than a new column. Write it as `JSON.stringify({ indexerName, origin, magnetUrl })` when minting a torrent candidate, and `JSON.stringify({ indexerName, origin })` for usenet. Task 10 reads it back at submit time; nothing else parses this blob, so its shape is owned by these two tasks jointly.

In `service.ts`, delete `searchInternetArchive` entirely and the `internet-archive` branch of the candidate-minting `flatMap`. The remaining structure — `forEachConcurrent`, the abort controller and timeout, `rankRelease`, `deduplicateReleases`, the `rejectedSources` counting and `unsafeDownloadUrlWarning` — all stay. Keep `unsafeDownloadUrlWarning` exactly as written: it is built only from counts and fixed labels so a credential cannot reach a warning.

`file-selection.ts`: delete `selectCandidateFiles` and `selectItemTorrent`; the module's remaining job is nothing, so delete the file and its test. `CandidateFilesResponse` is now built directly in the service from `decodeTorrentFiles`.

**Category derivation** — new logic, write it as a small exported pure function in `service.ts` or a sibling module and test it directly:

```ts
/**
 * Newznab groups categories in thousand-blocks: an indexer advertising 1010 or
 * 1020 can serve a request for the 1000 block. Sending a category an indexer
 * does not support yields an empty result set rather than an error, so the
 * query carries only categories the indexer actually claims.
 */
export function intersectCategories(
  platformCategoryIds: string[],
  indexerCategoryIds: string[]
): string[] {
  const advertised = new Set(indexerCategoryIds);
  const blocks = new Set(
    indexerCategoryIds.map((id) => String(Math.floor(Number(id) / 1000) * 1000))
  );
  return platformCategoryIds.filter((id) => {
    if (advertised.has(id)) return true;
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return false;
    const block = String(Math.floor(numeric / 1000) * 1000);
    // A block root is satisfied by any member of its block; a member is
    // satisfied by the indexer advertising the block root itself.
    return (numeric % 1000 === 0 && blocks.has(id)) || advertised.has(block);
  });
}
```

**Dedupe ordering** — in `deduplicateReleases` (`matcher.ts`), the `sources` array of each group must be sorted: seeders descending (nulls last), then indexer priority ascending, then `publishedAt` descending. Priority is not on `Release`, so pass a `priorityOf: (indexerId: string) => number` lookup into the sort from the service, or attach `priority` to `Release` — either is acceptable; pick one and use it consistently.

- [ ] **Step 1: Write failing service tests**

Rewrite `src/features/release-search/service.test.ts`. Delete every Internet Archive case and every `clientFactory`/`listIndexers` fake. Add a `ProwlarrPort` fake and these cases:

```ts
it("searches every enabled indexer", async () => {});
it("surfaces a 502 when discovery fails", async () => {});
it("keeps other indexers' results when one search fails", async () => {});
it("reports a warning naming the failed indexer", async () => {});
it("sends only categories the indexer advertises", async () => {});
it("treats a thousand-block root as satisfied by a member category", async () => {});
it("omits categories entirely when the intersection is empty", async () => {});
it("orders sources within a group by seeders, then priority, then date", async () => {});
it("persists the protocol on each candidate", async () => {});
it("reports which download clients are configured", async () => {});
it("drops a release whose download URL leaves the Prowlarr origin", async () => {});
it("never includes the api key in an unsafe-url warning", async () => {});
it("keeps seeders out of the match ranking", async () => {
  // Two releases, identical title evidence, different seeders -> same match class.
});
it("scales the deadline with the discovered indexer count", async () => {
  // Port the existing shared-host Prowlarr queue case at service.test.ts:397.
});
```

Also add `src/features/release-search/service.test.ts` cases for `listCandidateFiles`:

```ts
it("lists a torrent's files from metainfo", async () => {});
it("reports metadataPending for a magnet candidate", async () => {});
it("rejects a usenet candidate", async () => {});
it("returns 404 for an expired candidate", async () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/features/release-search/`
Expected: FAIL.

- [ ] **Step 3: Implement models, ports, repository and service**

Apply the deletions and the new shapes. In `repository.ts`, update the `SqliteCandidateRepository` insert and select to the new column set (`protocol`, `seeders`, no `source`), and keep the existing `get` filter `and(eq(id), gt(expiresAt, now()))` — the collapse of absence and expiry into one 404 is deliberate and must not change.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/release-search/ && pnpm typecheck`
Expected: release-search PASS. `typecheck` still fails in `downloads` and `src/app/api/**`.

- [ ] **Step 5: Commit**

```bash
git add src/features/release-search/
git commit -m "feat(release-search): fan out over Prowlarr indexers by protocol"
```

---

## Task 10: Download submission by protocol

**Files:**
- Modify: `src/features/downloads/models.ts`, `port.ts`, `service.ts`, and `service.test.ts`

**Interfaces:**
- Consumes: `ProwlarrFetcher` / `FetchedRelease` (Task 6), `TorrentClientPort` (Task 7), `ReleaseCandidateRecord` (Task 9).
- Produces:
  ```ts
  export type AttemptSourceType =
    | "prowlarr-usenet" | "prowlarr-torrent"
    | "newznab" | "internet-archive" | "internet-archive-torrent";
  export interface SubmitDownloadInput {
    submissionKey: string;
    candidateId: string;
    gameId: number;
    platformId: number;
    selectedFiles?: number[];
  }
  export interface SelectedFile { index: number; name: string; }
  ```
  `DownloadAttempt` gains `selectedFiles: SelectedFile[] | null` and `filesAppliedAt: number | null`, and its `sabMarker` field is renamed `marker` (column stays `sab_marker`). Task 11 consumes `selectedFiles` / `filesAppliedAt`.

**Background:** Delete `submitInternetArchiveTorrent` and the Internet Archive direct-download submit path, along with `InternetArchiveDownloadPort`, `InternetArchiveDownloadConfig` and `InternetArchiveTorrentConfig` from `port.ts`. Replace `NzbFetcherPort` with `ReleaseFetcherPort`.

`submit` now branches on `candidate.protocol`:
- `"usenet"` → the existing SABnzbd path, with `source: "prowlarr-usenet"`.
- `"torrent"` → claim, fetch, add to qBittorrent, with `source: "prowlarr-torrent"`.

**Fingerprints — this is the invariant most likely to be broken. Get it exactly right:**

```ts
function fingerprintParts(
  source: AttemptSourceType,
  input: SubmitDownloadInput,
  legacy: { iaFileName: string | null }
): Array<string | number> {
  switch (source) {
    case "prowlarr-usenet":
      return [input.candidateId, input.gameId, input.platformId];
    case "prowlarr-torrent":
      return [
        input.candidateId, input.gameId, input.platformId, "torrent",
        // Sorted so the same selection in a different order replays as the
        // same request. Empty for a whole-torrent grab.
        ...[...(input.selectedFiles ?? [])].sort((a, b) => a - b)
      ];
    // Legacy rows keep their original hashing so attempts already in deployed
    // databases still replay-match. Never change these three.
    case "newznab":
      return [input.candidateId, input.gameId, input.platformId];
    case "internet-archive":
      return [
        input.candidateId, input.gameId, input.platformId,
        // Read from the stored attempt, never from input: the replayed request
        // no longer carries a fileName field at all.
        legacy.iaFileName ?? ""
      ];
    case "internet-archive-torrent":
      return [input.candidateId, input.gameId, input.platformId, "torrent"];
  }
}
```

On replay, the source is read off the stored attempt (the candidate has a 30-minute TTL while the attempt row is permanent) — this is existing behaviour at `service.ts:726`; adapt its `assertSameRequest` comparison to the new source values rather than rewriting it.

The torrent submit path resolves selected file names server-side: after fetching a `.torrent` body, `decodeTorrentFiles` it and map each submitted index to its name, storing `SelectedFile[]`. An index with no matching file is a `validationError`. For a magnet payload, `selectedFiles` must be empty — reject a non-empty selection with `validationError("File selection is not available for a magnet release")`.

**Reading the magnet back.** Task 9 stores a torrent candidate's `magnetUrl` inside the `sourceSnapshot` JSON as `{ indexerName, origin, magnetUrl }`. Parse it here and pass `magnetUrl` into `ProwlarrFetcher.fetch`, which short-circuits to a validated magnet with no HTTP request when it is non-null. Treat a malformed or absent `magnetUrl` as `null` rather than throwing — a candidate minted before this field existed must still submit via the download proxy.

- [ ] **Step 1: Write failing tests**

In `src/features/downloads/service.test.ts`, delete the Internet Archive cases and add:

```ts
it("submits a torrent release to qBittorrent", async () => {});
it("submits a magnet release to qBittorrent", async () => {});
it("submits a usenet release to SABnzbd", async () => {});
it("stores resolved names alongside selected file indices", async () => {});
it("rejects a selected index the torrent does not contain", async () => {});
it("rejects a file selection on a magnet release", async () => {});
it("parks an ambiguous add in Unknown", async () => {});
it("returns the existing attempt when a submission key replays", async () => {});
it("fails a replay whose selection differs", async () => {});
it("hashes a selection identically regardless of index order", async () => {});
it("still matches a legacy newznab attempt on replay", async () => {
  // Seed an attempt with source 'newznab' and a fingerprint computed the old
  // way, replay it, and assert the existing attempt is returned unchanged.
});
it("still matches a legacy internet-archive attempt on replay", async () => {
  // fileName comes from the stored ia_file_name, not from input.
});
it("never contains an external await inside the claim transaction", async () => {
  // Assert the repository's transaction callback completes before the fetch
  // fake is first called.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/features/downloads/service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Apply the model, port and service changes. Rename `sabMarker` → `marker` across `models.ts`, `repository.ts` and `service.ts`, leaving the Drizzle column mapping as `text("sab_marker")` with a comment explaining the split.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/downloads/ && pnpm typecheck`
Expected: downloads PASS; `typecheck` still fails in `src/app/api/**`.

- [ ] **Step 5: Commit**

```bash
git add src/features/downloads/
git commit -m "feat(downloads): submit releases by protocol with source-derived fingerprints"
```

---

## Task 11: Reconcile, file selection and recovery

**Files:**
- Modify: `src/features/downloads/service.ts`, `repository.ts`, and their tests

**Interfaces:**
- Consumes: everything from Task 10, plus `listFiles` / `setFilePriorities` (Task 7).
- Produces: no new exports. Behaviour only.

**Background:** `reconcileTorrents` (`service.ts:660`) currently filters `attempt.source !== "internet-archive-torrent"`. Widen it to every torrent-delivered attempt: `"prowlarr-torrent"` and the legacy `"internet-archive-torrent"`. Matching by `torrentHash`, falling back to tag membership against `marker`, is unchanged.

Add the file-selection application in the same pass, after status reconciliation. For each non-terminal torrent attempt with a non-empty `selectedFiles` and a null `filesAppliedAt`:

1. Resolve the hash from `attempt.torrentHash`, or from the matched job in the `list()` result already in hand.
2. `listFiles(hash)`. Empty means metadata has not arrived — skip, retry next tick.
3. Verify: for every `SelectedFile`, the entry at that index in the listing must have the same `name`. Any mismatch aborts application for that attempt, stamps nothing, and records `failureDetail: "Torrent file list did not match the selection"` without changing status.
4. `setFilePriorities(hash, unselectedIndices, 0)` where `unselectedIndices` is every listed index not in the selection. When that set is empty, make no call.
5. Stamp `filesAppliedAt`.

`SqliteDownloadRepository.update` is a conditional `UPDATE … WHERE status NOT IN ('Completed','Failed')`, so a `filesAppliedAt` stamp on a terminal attempt is refused and returns the unchanged row — that is correct and must not be worked around.

Startup recovery: delete the Internet Archive direct-download branch. Add a one-time pass that fails any non-terminal attempt whose source is `"internet-archive"` with `failureDetail: "The direct download path was removed"`.

- [ ] **Step 1: Write failing tests**

```ts
it("reconciles a prowlarr torrent by hash", async () => {});
it("reconciles a prowlarr torrent by tag when no hash was returned", async () => {});
it("still reconciles a legacy internet-archive-torrent attempt", async () => {});
it("skips file application until metadata arrives", async () => {
  // listFiles returns [] on tick one, entries on tick two.
});
it("deprioritises every unselected file", async () => {});
it("makes no priority call when every file is selected", async () => {});
it("stamps filesAppliedAt exactly once", async () => {
  // Two ticks, one setFilePriorities call.
});
it("resumes file application after a restart", async () => {
  // Build a fresh service over the same repository state; assert it applies.
});
it("aborts application when a name no longer matches its index", async () => {});
it("refuses a filesAppliedAt stamp on a terminal attempt", async () => {});
it("fails leftover internet-archive attempts on startup", async () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/features/downloads/service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: features PASS; `typecheck` fails only in `src/app/api/**`.

- [ ] **Step 5: Commit**

```bash
git add src/features/downloads/
git commit -m "feat(downloads): apply file selection and reconcile every torrent attempt"
```

---

## Task 12: API layer

**Files:**
- Modify: `src/app/api/settings/**`, `src/app/api/releases/**`, `src/app/api/downloads/**`, `src/app/api/platforms/**`
- Delete: any indexer-specific route directory under `src/app/api/settings/`

**Interfaces:**
- Consumes: every feature from Tasks 8–11.
- Produces: the composition roots Task 15's e2e run exercises.

**Background:** Keep the four-file split. `dependencies.ts` is the only place that may construct `ProwlarrClient`, `ProwlarrFetcher` or `QbittorrentClient`.

`src/app/api/releases/dependencies.ts` becomes:

```ts
export function releaseSearchDependencies() {
  const database = getDatabase();
  const settings = new SqliteSettingsRepository(database);
  const prowlarr = settings.getProwlarr();
  return {
    service: new ReleaseSearchService({
      catalog: new SqliteCatalogRepository(database),
      candidates: new SqliteCandidateRepository(database),
      prowlarr: prowlarr === null ? null : new ProwlarrClient({
        baseUrl: process.env.GAMARR_PROWLARR_BASE_URL ?? prowlarr.baseUrl,
        apiKey: prowlarr.apiKey,
        timeoutMs: Math.min(prowlarr.timeoutMs, 10_000)
      }),
      usenetClientConfigured: () => Boolean(settings.getSabnzbd()?.apiKey),
      torrentClientConfigured: () => Boolean(settings.getQbittorrent()?.password)
    }),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
```

A null `prowlarr` port must make the search handler answer `503 "Prowlarr is not configured"`, not throw.

In `src/app/api/downloads/dependencies.ts`, delete `internetArchiveMaxBytes`, `internetArchiveTorrentMaxBytes`, the `iaBaseUrl` block and the `downloadDir` line; add `maxTorrentBytes: byteLimitFromEnv(process.env.GAMARR_PROWLARR_MAX_TORRENT_BYTES) ?? 8 * 1024 * 1024`.

Settings routes: replace the indexer create/update/delete/test routes with a single Prowlarr save + test. The test handler calls `listIndexers()` and returns `{ indexers: Array<{ id, name, protocol, priority }> , usenet: number, torrent: number }` — names and protocols only, never a credential. All of these stay guarded non-`GET` through `assertTrustedMutation`.

Platform routes: the category editor now writes `savePlatformCategories(platformId, categoryIds)`.

- [ ] **Step 1: Update handler tests first**

For each modified `handlers.test.ts`, update the hand-rolled fakes to the new structural interfaces and add:

```ts
it("returns 503 when Prowlarr is not configured", async () => {});
it("rejects a cross-origin mutation", async () => {
  // Existing case — keep it, it must still pass.
});
it("never returns the prowlarr api key", async () => {
  // Serialize the whole response body and assert the key string is absent.
});
it("returns discovered indexer names and protocols from a test", async () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/api/`

- [ ] **Step 3: Implement routes, dependencies and handlers**

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: **everything passes now.** If `typecheck` still reports errors, they are in the UI — that is Task 13.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/
git commit -m "feat(api): compose the Prowlarr release and settings routes"
```

---

## Task 13: User interface

**Files:**
- Modify: `src/features/settings/settings-screen.tsx`, `setup-screen.tsx`, `src/features/release-search/release-results.tsx`, `download-dialog.tsx`, and their tests

**Interfaces:**
- Consumes: `PublicProwlarrSettings` (Task 8), `PublicReleaseSource` / `CandidateFilesResponse` (Task 9).
- Produces: no exports consumed by later tasks.

**Background:**
- **Settings/setup:** remove the indexer list and its add/edit/delete flow. Add one Prowlarr card matching the existing SABnzbd and qBittorrent cards (base URL, API key with the retain/clear/replace secret control, timeout, Test button). After a successful test, render the discovered indexers read-only as name + protocol + priority, with a line stating that indexers are managed in Prowlarr.
- **Release results:** add a protocol indicator and a seeder count per source. Protocol must encode meaning in text and shape, never colour alone — follow whatever pattern match rank already uses in this file.
- **Download dialog:** four states — usenet (submit, no file list); torrent with metainfo (file selector listing torrent contents, selecting nothing means the whole torrent); torrent from a magnet (no selector, plain text explaining the file list is unknown until metadata arrives); client not configured (shown, disabled, with the reason).
- Never put the API key, or any URL containing it, in a React Query key or an error report.

- [ ] **Step 1: Write failing component tests**

Each test file needs the `/** @vitest-environment jsdom */` first-line docblock.

```ts
it("renders a protocol label as text, not colour alone", () => {});
it("shows the seeder count for a torrent source", () => {});
it("shows no seeder count for a usenet source", () => {});
it("lists torrent files when metainfo is available", () => {});
it("explains that a magnet has no file list yet", () => {});
it("disables submission when the matching client is unconfigured", () => {});
it("states why submission is disabled", () => {});
it("renders the discovered indexer list after a successful test", () => {});
it("never renders the prowlarr api key", () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/features/settings/ src/features/release-search/`

- [ ] **Step 3: Implement the screens**

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/ src/features/release-search/
git commit -m "feat(ui): configure Prowlarr and show release protocol and health"
```

---

## Task 14: Delete the retired integrations

**Files:**
- Delete: `src/integrations/newznab/`, `src/integrations/internet-archive/`
- Modify: `CLAUDE.md`, `README.md`, `Dockerfile` / `docker-compose` sample if either names a removed variable

**Interfaces:** none. This task only removes code.

**Background:** By now nothing should import either directory. Confirm before deleting; a surviving import means an earlier task is incomplete.

- [ ] **Step 1: Prove nothing imports the retired modules**

```bash
grep -rn "integrations/newznab\|integrations/internet-archive" src/ tests/ || echo "clean"
```
Expected: `clean`. If anything is listed, fix that file before continuing.

- [ ] **Step 2: Delete**

```bash
git rm -r src/integrations/newznab src/integrations/internet-archive
```

- [ ] **Step 3: Remove the retired environment variables**

```bash
grep -rn "GAMARR_IA_\|GAMARR_DOWNLOAD_DIRECTORY" . --include="*.ts" --include="*.tsx" --include="*.md" --include="*.yml" --include="*.yaml" --include="Dockerfile" --include="*.sh"
```
Remove every hit. Then update the environment table in `CLAUDE.md` and `README.md`: delete the five `GAMARR_IA_*` / `GAMARR_DOWNLOAD_DIRECTORY` rows, add `GAMARR_PROWLARR_MAX_TORRENT_BYTES` (default `8388608`) and `GAMARR_PROWLARR_BASE_URL` (test-only override).

- [ ] **Step 4: Update the architecture prose in CLAUDE.md**

Rewrite the paragraphs describing the Internet Archive source and the per-indexer Newznab configuration to describe the Prowlarr connection instead. Preserve the "Invariants worth knowing before editing" section's rules, updating only the names: the download-submission idempotence paragraph must now describe the five source values and the two fingerprint rules from Task 10.

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove the Newznab and Internet Archive integrations"
```

---

## Task 15: End-to-end coverage

**Files:**
- Modify: `tests/provider-server/**`, `tests/e2e/**`, `playwright.config.ts` if a new env var must be passed through
- Delete: Internet Archive e2e specs and fixtures

**Interfaces:** none.

**Background:** The stub provider server already backs IGDB via `GAMARR_IGDB_BASE_URL`. Add Prowlarr the same way, reached through `GAMARR_PROWLARR_BASE_URL`. E2E runs single-worker and non-parallel because it shares one SQLite file — do not change that.

The stub must serve:
- `GET /api/v1/indexer` — two entries, one `protocol: "torrent"` and one `protocol: "usenet"`, both `enable: true`, with `capabilities.categories`. Assert the request carried an `X-Api-Key` header.
- `GET /api/v1/indexer/:id/newznab` — a Torznab RSS document with `seeders`, `peers` and an enclosure pointing back at the stub's download path.
- `GET /api/v1/indexer/:id/download` — serves real `.torrent` bytes on one `link` value and answers `302` to a `magnet:` URI on another.

- [ ] **Step 1: Delete the retired e2e coverage**

```bash
grep -rln "internet.archive\|internetArchive" tests/e2e tests/provider-server
```
Delete the specs and fixtures that hit, and any IA route handlers in the stub server.

- [ ] **Step 2: Add the Prowlarr stub**

Follow the existing IGDB stub's structure in `tests/provider-server/`.

- [ ] **Step 3: Write the e2e spec**

Create `tests/e2e/prowlarr-search-and-download.spec.ts` covering: configure Prowlarr in settings → test connection shows both indexers → search a game → results show both protocols with a seeder count on the torrent → submit the torrent release → the attempt appears in Activity and reaches a non-Pending status. Keep the `@axe-core/playwright` assertion on every page the spec visits.

- [ ] **Step 4: Run e2e**

Run: `pnpm test:e2e`
Expected: PASS. If the fixture database is stale, `global-setup.ts` recreates `test-results/e2e/gamarr.db` from `drizzle/` — confirm it picks up `0006`.

- [ ] **Step 5: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`
Expected: all five clean. This is the acceptance gate.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(e2e): drive the Prowlarr search and torrent download path"
```

---

## Execution notes for codex

Each task above is self-contained: it names its files, its interfaces, its tests and its verification commands. Run tasks in numeric order except Tasks 1, 2 and 3, which touch disjoint files and may run in parallel.

**On the test lists.** Tasks 5 and 8–13 give test *names* with empty or commented bodies. Those names are the specification, not a suggestion: implement every one with a real arrange/act/assert body against a hand-written fake, and do not add a task's implementation before its tests fail for the right reason. A task is not done while any listed test is missing, skipped, or asserting less than its name claims. Where a name is ambiguous, the design spec section it comes from is authoritative — `docs/superpowers/specs/2026-08-11-prowlarr-torrent-indexers-design.md`.

Three rules that override anything a task seems to imply:

1. **Never edit a committed migration.** If `0006` is wrong after it is committed, add `0007`.
2. **Never weaken a test to make it pass.** If a test in this plan contradicts the implementation you find, the test is the specification — the plan was written from the design spec. Stop and report the contradiction rather than editing the assertion.
3. **Never let the Prowlarr API key into a response, a log line, an error message, or a URL Gamarr builds.** If a task's instructions appear to require it, they are wrong — stop and report.
