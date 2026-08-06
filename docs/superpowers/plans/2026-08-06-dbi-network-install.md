# DBI Network Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve completed Switch game files from operator-nominated directories as an Apache-style HTML index that DBI can browse and install from over the LAN, with resumable range requests.

**Architecture:** A `switch-library` feature slice owns naming and composition; a filesystem adapter in `src/integrations/filesystem/` satisfies the scanner port; two `GET`-only routes under `/api/dbi` render the index and stream files. Both routes rescan on every request — there is no cache. The URL segment is only ever a map key looked up against a fresh scan, never joined onto a filesystem path, so no traversal surface exists.

**Tech Stack:** Next.js App Router (`runtime = "nodejs"`, `dynamic = "force-dynamic"`), Drizzle + better-sqlite3, Vitest (node environment), Node 24 `fs/promises`.

**Spec:** `docs/superpowers/specs/2026-08-06-dbi-network-install-design.md`

### One refinement against the spec

The spec's `SwitchLibraryEntry` carries both `slug` and `displayName`. They are always equal — DBI derives the install filename from the URL basename, so the link text and the URL segment must match. Two fields holding one value invites drift, so the implementation uses a single `name`, percent-encoded at the HTML boundary and decoded on the way back in. Nothing else about the design changes.

## Global Constraints

- Node 24 and pnpm; run everything through `pnpm`.
- Every route file exports `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
- Vitest environment is `node`; none of these tests need the jsdom docblock.
- Path aliases: `@/*` → `src/*`, `@tests/*` → `tests/*`.
- `clearMocks` and `restoreMocks` are global — do not hand-roll spy teardown.
- Features reach the outside world only through ports. `dependencies.ts` is the only place a port is bound to a concrete adapter.
- `slug-policy.ts` and `range.ts` are pure with no I/O, so `service.ts` and `handlers.ts` may import them directly — the same exemption already granted to `newznab/url-policy`.
- Every error is an `AppError` serialized by `errorResponse()`. **No absolute filesystem path may appear in any error message**, following `DownloadUrlPolicyError`.
- Installable extensions, exactly: `.nsp`, `.nsz`, `.xci`, `.xcz`.
- `GAMARR_SWITCH_LIBRARY_DIR` is a comma-separated list of absolute roots. Unset or empty means both routes return `404`.
- Prefer hand-written fakes implementing a port over module mocking.

---

### Task 1: Slug policy (pure)

**Files:**
- Create: `src/features/switch-library/slug-policy.ts`
- Test: `src/features/switch-library/slug-policy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isInstallableFileName(name: string): boolean`, `isExcludedFileName(name: string): boolean`, `markerFromDirName(dirName: string): string | null`, `extensionOf(fileName: string): string`, `resolveDisplayNames(candidates: NamedCandidate[]): Map<string, string>`, `interface NamedCandidate { absolutePath: string; preferredName: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import {
  extensionOf,
  isExcludedFileName,
  isInstallableFileName,
  markerFromDirName,
  resolveDisplayNames
} from "@/features/switch-library/slug-policy";

describe("isInstallableFileName", () => {
  it("accepts the four Switch container extensions regardless of case", () => {
    expect(isInstallableFileName("Game.nsp")).toBe(true);
    expect(isInstallableFileName("Game.NSZ")).toBe(true);
    expect(isInstallableFileName("Game.xci")).toBe(true);
    expect(isInstallableFileName("Game.XcZ")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isInstallableFileName("Game.3ds")).toBe(false);
    expect(isInstallableFileName("readme.txt")).toBe(false);
    expect(isInstallableFileName("Game")).toBe(false);
  });
});

describe("isExcludedFileName", () => {
  it("excludes dotfiles and in-progress part files", () => {
    // The downloader writes `.gamarr-{attemptId}.part` beside the eventual
    // file. Serving one would hand DBI a truncated NSP that fails hash
    // verification partway through an install.
    expect(isExcludedFileName(".gamarr-abc.part")).toBe(true);
    expect(isExcludedFileName(".DS_Store")).toBe(true);
    expect(isExcludedFileName("Game.xci.part")).toBe(true);
  });

  it("does not exclude ordinary names", () => {
    expect(isExcludedFileName("Game.xci")).toBe(false);
  });
});

describe("markerFromDirName", () => {
  it("returns the directory name when it is an attempt marker", () => {
    // sab_marker is written as `gamarr-{attemptId}` for every attempt
    // regardless of source, and carries a UNIQUE index.
    expect(markerFromDirName("gamarr-998e730a-7029-4541-bf4d-9e743e5ba848"))
      .toBe("gamarr-998e730a-7029-4541-bf4d-9e743e5ba848");
  });

  it("returns null for anything else", () => {
    expect(markerFromDirName("games")).toBeNull();
    expect(markerFromDirName("gamarr-")).toBeNull();
    expect(markerFromDirName("gamarr-has spaces")).toBeNull();
  });
});

describe("extensionOf", () => {
  it("returns the trailing extension including the dot", () => {
    expect(extensionOf("Game.xci")).toBe(".xci");
    expect(extensionOf("Game.part.nsp")).toBe(".nsp");
  });

  it("returns empty string when there is no extension", () => {
    expect(extensionOf("Game")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
  });
});

describe("resolveDisplayNames", () => {
  it("leaves a unique name untouched", () => {
    const names = resolveDisplayNames([
      { absolutePath: "/a/Game.xci", preferredName: "Game.xci" }
    ]);
    expect(names.get("/a/Game.xci")).toBe("Game.xci");
  });

  it("numbers collisions by absolute path, inserting before the extension", () => {
    // readdir order is not guaranteed, so numbering must key off the path.
    const names = resolveDisplayNames([
      { absolutePath: "/z/Game.xci", preferredName: "Game.xci" },
      { absolutePath: "/a/Game.xci", preferredName: "Game.xci" }
    ]);
    expect(names.get("/a/Game.xci")).toBe("Game.xci");
    expect(names.get("/z/Game.xci")).toBe("Game (2).xci");
  });

  it("produces the same numbering regardless of input order", () => {
    const forward = resolveDisplayNames([
      { absolutePath: "/a/G.xci", preferredName: "G.xci" },
      { absolutePath: "/b/G.xci", preferredName: "G.xci" },
      { absolutePath: "/c/G.xci", preferredName: "G.xci" }
    ]);
    const reversed = resolveDisplayNames([
      { absolutePath: "/c/G.xci", preferredName: "G.xci" },
      { absolutePath: "/b/G.xci", preferredName: "G.xci" },
      { absolutePath: "/a/G.xci", preferredName: "G.xci" }
    ]);
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
    expect(forward.get("/c/G.xci")).toBe("G (3).xci");
  });

  it("treats names differing only by case as colliding", () => {
    const names = resolveDisplayNames([
      { absolutePath: "/a/game.xci", preferredName: "game.xci" },
      { absolutePath: "/b/GAME.xci", preferredName: "GAME.xci" }
    ]);
    expect(names.get("/b/GAME.xci")).toBe("GAME (2).xci");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/features/switch-library/slug-policy.test.ts`
Expected: FAIL — cannot resolve module `@/features/switch-library/slug-policy`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Pure naming rules for the DBI library index. No I/O — handlers and the
 * service may import this directly, the same way release-search imports
 * `newznab/url-policy`.
 */

const INSTALLABLE_EXTENSIONS = [".nsp", ".nsz", ".xci", ".xcz"] as const;

/**
 * Permissive but bounded. `sab_marker` is `gamarr-{attemptId}` and attempt ids
 * are generated uuids today, but the column is plain text, so this matches the
 * shape rather than asserting a uuid.
 */
const markerPattern = /^gamarr-[A-Za-z0-9._-]{1,64}$/;

export interface NamedCandidate {
  absolutePath: string;
  preferredName: string;
}

export function isInstallableFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return INSTALLABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isExcludedFileName(name: string): boolean {
  if (name.startsWith(".")) return true;
  return name.toLowerCase().endsWith(".part");
}

export function markerFromDirName(dirName: string): string | null {
  return markerPattern.test(dirName) ? dirName : null;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot);
}

/**
 * Maps absolute path -> unique display name. Entries sharing a name are
 * ordered by absolute path and numbered from the second onward, because
 * `readdir` order is not stable and a file's number must not move between
 * scans.
 */
export function resolveDisplayNames(
  candidates: NamedCandidate[]
): Map<string, string> {
  const groups = new Map<string, NamedCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.preferredName.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const names = new Map<string, string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) =>
      a.absolutePath < b.absolutePath ? -1 : a.absolutePath > b.absolutePath ? 1 : 0
    );
    ordered.forEach((candidate, index) => {
      names.set(
        candidate.absolutePath,
        index === 0
          ? candidate.preferredName
          : suffixed(candidate.preferredName, index + 1)
      );
    });
  }
  return names;
}

function suffixed(name: string, ordinal: number): string {
  const extension = extensionOf(name);
  const stem = extension === "" ? name : name.slice(0, -extension.length);
  return `${stem} (${ordinal})${extension}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/features/switch-library/slug-policy.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/features/switch-library/slug-policy.ts src/features/switch-library/slug-policy.test.ts
git commit -m "feat(switch-library): add pure naming rules for the DBI index"
```

---

### Task 2: Range header parsing (pure)

**Files:**
- Create: `src/features/switch-library/range.ts`
- Test: `src/features/switch-library/range.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRangeHeader(header: string | null, sizeBytes: number): RangeResult`, `type RangeResult = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { parseRangeHeader } from "@/features/switch-library/range";

describe("parseRangeHeader", () => {
  it("treats a missing header as the whole file", () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: "full" });
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 1000))
      .toEqual({ kind: "partial", start: 0, end: 99 });
  });

  it("parses an open-ended range as running to the last byte", () => {
    // This is the resume case: DBI reconnects asking for everything from
    // where it stopped. It must work or a dropped transfer restarts at zero.
    expect(parseRangeHeader("bytes=500-", 1000))
      .toEqual({ kind: "partial", start: 500, end: 999 });
  });

  it("clamps an end past the last byte", () => {
    expect(parseRangeHeader("bytes=0-99999", 1000))
      .toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("parses a suffix range as the trailing bytes", () => {
    expect(parseRangeHeader("bytes=-200", 1000))
      .toEqual({ kind: "partial", start: 800, end: 999 });
  });

  it("clamps an oversized suffix range to the whole file", () => {
    expect(parseRangeHeader("bytes=-99999", 1000))
      .toEqual({ kind: "partial", start: 0, end: 999 });
  });

  it("reports a start at or past the end as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=1500-1600", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("reports a backwards range as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=500-100", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("reports a zero-length suffix as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a malformed or multi-range header rather than failing", () => {
    // RFC 9110: an unparseable Range is ignored and the full representation
    // is returned. Multi-range is deliberately unsupported.
    expect(parseRangeHeader("bytes=0-1,5-6", 1000)).toEqual({ kind: "full" });
    expect(parseRangeHeader("items=0-1", 1000)).toEqual({ kind: "full" });
    expect(parseRangeHeader("garbage", 1000)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=-", 1000)).toEqual({ kind: "full" });
  });

  it("reports any range against an empty file as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/features/switch-library/range.test.ts`
Expected: FAIL — cannot resolve module `@/features/switch-library/range`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Pure parsing of a single-range HTTP `Range` header. No I/O.
 *
 * Multi-range is unsupported on purpose: DBI never sends it, and honoring it
 * would mean multipart/byteranges for no benefit. Per RFC 9110 an
 * unrecognized range is ignored rather than rejected, so anything that does
 * not parse yields the full representation.
 */

export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const singleRange = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(
  header: string | null,
  sizeBytes: number
): RangeResult {
  if (header === null) return { kind: "full" };
  const match = singleRange.exec(header.trim());
  if (!match) return { kind: "full" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "full" };
  if (sizeBytes === 0) return { kind: "unsatisfiable" };

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: "unsatisfiable" };
    return {
      kind: "partial",
      start: Math.max(0, sizeBytes - suffix),
      end: sizeBytes - 1
    };
  }

  const start = Number(rawStart);
  if (start >= sizeBytes) return { kind: "unsatisfiable" };
  const end = rawEnd === "" ? sizeBytes - 1 : Math.min(Number(rawEnd), sizeBytes - 1);
  if (end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/features/switch-library/range.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/features/switch-library/range.ts src/features/switch-library/range.test.ts
git commit -m "feat(switch-library): parse single-range HTTP range headers"
```

---

### Task 3: Models and ports

**Files:**
- Create: `src/features/switch-library/models.ts`
- Create: `src/features/switch-library/ports.ts`

No test — these are type declarations with no behavior. Task 4 is the first consumer and proves they compile.

**Interfaces:**
- Consumes: nothing.
- Produces: `SwitchLibraryFile`, `SwitchLibraryEntry`, `SwitchLibraryScanner`, `SwitchLibraryTitleReader`, `OpenedFile`, `FileOpener`.

- [ ] **Step 1: Write the models**

```ts
/** One installable file found on disk by a scan. */
export interface SwitchLibraryFile {
  /** Fully resolved, symlinks followed, confirmed inside its root. */
  absolutePath: string;
  fileName: string;
  /**
   * Basename of the containing directory. Where this is `gamarr-{attemptId}`
   * it matches `download_attempts.sab_marker` exactly and yields a real game
   * title.
   */
  parentDirName: string;
  sizeBytes: number;
  sourceRoot: string;
}

/**
 * One row of the rendered index. `name` is both the link text and the URL
 * segment — DBI derives the filename it installs under from the URL basename,
 * so the two cannot diverge.
 */
export interface SwitchLibraryEntry {
  name: string;
  absolutePath: string;
  sizeBytes: number;
}
```

- [ ] **Step 2: Write the ports**

```ts
import type { SwitchLibraryFile } from "@/features/switch-library/models";

export interface SwitchLibraryScanner {
  scan(roots: string[]): Promise<SwitchLibraryFile[]>;
}

export interface SwitchLibraryTitleReader {
  /** Maps `sab_marker` -> game title. Absent markers are simply omitted. */
  titlesByMarker(markers: string[]): Map<string, string>;
}

/**
 * An open file descriptor plus its size, read under one handle.
 *
 * Ownership rule: once `stream()` is called the returned stream owns the
 * handle and closes it on end or destroy. Call `close()` only on paths that
 * never stream — a 416, or an error before streaming begins — or the handle
 * is closed twice.
 */
export interface OpenedFile {
  sizeBytes: number;
  stream(start: number, end: number): ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface FileOpener {
  /** Resolves null when the path is missing, unreadable, or not a regular file. */
  open(absolutePath: string): Promise<OpenedFile | null>;
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/switch-library/models.ts src/features/switch-library/ports.ts
git commit -m "feat(switch-library): declare models and ports"
```

---

### Task 4: Filesystem scanner adapter

**Files:**
- Create: `src/integrations/filesystem/switch-library-scanner.ts`
- Test: `src/integrations/filesystem/switch-library-scanner.test.ts`

**Interfaces:**
- Consumes: `SwitchLibraryFile` and `SwitchLibraryScanner` from Task 3; `isExcludedFileName` and `isInstallableFileName` from Task 1.
- Produces: `class FilesystemSwitchLibraryScanner implements SwitchLibraryScanner`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemSwitchLibraryScanner } from "@/integrations/filesystem/switch-library-scanner";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function root(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-switch-"));
  directories.push(directory);
  return directory;
}

function write(base: string, relative: string, contents = "x"): string {
  const full = path.join(base, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

describe("FilesystemSwitchLibraryScanner", () => {
  it("finds installable files at depth one and depth two", async () => {
    const base = root();
    write(base, "Top.xci", "aa");
    write(base, "gamarr-abc/Nested.nsp", "bbb");

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files.map((file) => file.fileName).sort()).toEqual(["Nested.nsp", "Top.xci"]);
    const nested = files.find((file) => file.fileName === "Nested.nsp");
    expect(nested?.parentDirName).toBe("gamarr-abc");
    expect(nested?.sizeBytes).toBe(3);
  });

  it("does not descend below depth two", async () => {
    const base = root();
    write(base, "a/b/Deep.xci");

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toEqual([]);
  });

  it("skips non-installable extensions, dotfiles, and part files", async () => {
    const base = root();
    write(base, "Game.3ds");
    write(base, "notes.txt");
    write(base, ".hidden.xci");
    write(base, "dir/.gamarr-abc.part");

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toEqual([]);
  });

  it("rejects a symlink escaping its root", async () => {
    const outside = root();
    const secret = write(outside, "Secret.xci");
    const base = root();
    symlinkSync(secret, path.join(base, "Link.xci"));

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toEqual([]);
  });

  it("reports a symlink and its in-root target only once", async () => {
    // Both resolve to the same realpath. Emitting both would put two rows in
    // the index that name the same bytes, and since display names are keyed by
    // absolute path one would silently overwrite the other.
    const base = root();
    write(base, "real/Game.xci", "abcd");
    symlinkSync(path.join(base, "real/Game.xci"), path.join(base, "Alias.xci"));

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toHaveLength(1);
    expect(files[0].absolutePath).toBe(path.join(await realpath(base), "real/Game.xci"));
  });

  it("reports a file reachable from two roots only once", async () => {
    const base = root();
    write(base, "nested/Game.xci");

    const files = await new FilesystemSwitchLibraryScanner()
      .scan([base, path.join(base, "nested")]);

    expect(files).toHaveLength(1);
  });

  it("skips a root that does not exist instead of throwing", async () => {
    const base = root();
    write(base, "Game.xci");

    const files = await new FilesystemSwitchLibraryScanner()
      .scan([path.join(base, "missing"), base]);

    expect(files.map((file) => file.fileName)).toEqual(["Game.xci"]);
  });

  it("returns nothing for an empty root list", async () => {
    expect(await new FilesystemSwitchLibraryScanner().scan([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/integrations/filesystem/switch-library-scanner.test.ts`
Expected: FAIL — cannot resolve module `@/integrations/filesystem/switch-library-scanner`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { SwitchLibraryFile } from "@/features/switch-library/models";
import type { SwitchLibraryScanner } from "@/features/switch-library/ports";
import {
  isExcludedFileName,
  isInstallableFileName
} from "@/features/switch-library/slug-policy";

const MAX_DEPTH = 2;

/**
 * Walks operator-nominated roots for installable Switch files.
 *
 * Every candidate is resolved with `realpath` and re-checked against its root,
 * so a symlink planted in a read-only mount cannot reach outside it. A root
 * that is missing or unreadable is skipped rather than failing the scan —
 * a misconfigured second mount should not take the whole index down.
 */
export class FilesystemSwitchLibraryScanner implements SwitchLibraryScanner {
  async scan(roots: string[]): Promise<SwitchLibraryFile[]> {
    // Keyed by resolved path: a symlink and its target, or two overlapping
    // roots, must not yield two rows naming the same bytes. Display names are
    // keyed by absolute path downstream, so a duplicate would overwrite rather
    // than collide, and one row would silently take the other's name.
    const found = new Map<string, SwitchLibraryFile>();
    for (const root of roots) {
      const resolvedRoot = await resolveOrNull(root);
      if (resolvedRoot === null) continue;
      await this.collect(resolvedRoot, resolvedRoot, 1, found);
    }
    return [...found.values()];
  }

  private async collect(
    directory: string,
    root: string,
    depth: number,
    into: Map<string, SwitchLibraryFile>
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) {
          await this.collect(full, root, depth + 1, into);
        }
        continue;
      }

      if (!isInstallableFileName(entry.name)) continue;
      if (isExcludedFileName(entry.name)) continue;

      const resolved = await resolveOrNull(full);
      if (resolved === null || !isInside(resolved, root)) continue;

      let stats;
      try {
        stats = await stat(resolved);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      if (into.has(resolved)) continue;

      into.set(resolved, {
        absolutePath: resolved,
        fileName: entry.name,
        // Taken from the logical path, not the resolved one: the
        // `gamarr-{attemptId}` directory is where the file is linked from,
        // which is what identifies the attempt.
        parentDirName: path.basename(directory),
        sizeBytes: stats.size,
        sourceRoot: root
      });
    }
  }
}

async function resolveOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * `path.relative` rather than a `startsWith` prefix test, which would accept
 * `/library-other` as being inside `/library`.
 */
function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return false;
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/integrations/filesystem/switch-library-scanner.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/filesystem/switch-library-scanner.ts src/integrations/filesystem/switch-library-scanner.test.ts
git commit -m "feat(switch-library): scan roots for installable files, confined to each root"
```

---

### Task 5: Title repository

**Files:**
- Create: `src/features/switch-library/repository.ts`
- Test: `src/features/switch-library/repository.test.ts`

**Interfaces:**
- Consumes: `SwitchLibraryTitleReader` from Task 3.
- Produces: `class SqliteSwitchLibraryRepository implements SwitchLibraryTitleReader`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import {
  downloadAttempts,
  games,
  libraryEntries,
  platforms
} from "@/db/schema";
import { SqliteSwitchLibraryRepository } from "@/features/switch-library/repository";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-switchlib-"));
  directories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  return {
    database,
    repository: new SqliteSwitchLibraryRepository(database)
  };
}

function seedAttempt(
  database: Database,
  options: { attemptId: string; gameId: number; title: string }
): void {
  database.insert(platforms)
    .values({ id: 130, name: "Nintendo Switch", lastSyncedAt: 1 })
    .onConflictDoNothing()
    .run();
  database.insert(games)
    .values({ id: options.gameId, title: options.title, slug: `g${options.gameId}`, cachedAt: 1 })
    .run();
  const entryId = `entry-${options.gameId}`;
  database.insert(libraryEntries)
    .values({
      id: entryId,
      gameId: options.gameId,
      platformId: 130,
      createdAt: 1,
      updatedAt: 1
    })
    .run();
  database.insert(downloadAttempts)
    .values({
      id: options.attemptId,
      libraryEntryId: entryId,
      submissionKey: `sub-${options.attemptId}`,
      requestFingerprint: `fp-${options.attemptId}`,
      status: "Completed",
      source: "internet-archive",
      releaseTitle: options.title,
      indexerNameSnapshot: "test",
      sabnzbdConfigRevision: 1,
      sabMarker: `gamarr-${options.attemptId}`,
      createdAt: 1,
      updatedAt: 1
    })
    .run();
}

describe("SqliteSwitchLibraryRepository", () => {
  it("maps a marker to its game title", () => {
    const { database, repository: reader } = repository();
    seedAttempt(database, { attemptId: "abc", gameId: 1, title: "Metroid Prime 4" });

    const titles = reader.titlesByMarker(["gamarr-abc"]);

    expect(titles.get("gamarr-abc")).toBe("Metroid Prime 4");
  });

  it("omits markers with no matching attempt", () => {
    const { database, repository: reader } = repository();
    seedAttempt(database, { attemptId: "abc", gameId: 1, title: "Metroid Prime 4" });

    const titles = reader.titlesByMarker(["gamarr-abc", "gamarr-missing"]);

    expect(titles.has("gamarr-missing")).toBe(false);
    expect(titles.size).toBe(1);
  });

  it("resolves several markers in one call", () => {
    const { database, repository: reader } = repository();
    seedAttempt(database, { attemptId: "one", gameId: 1, title: "Game One" });
    seedAttempt(database, { attemptId: "two", gameId: 2, title: "Game Two" });

    const titles = reader.titlesByMarker(["gamarr-one", "gamarr-two"]);

    expect(titles.get("gamarr-one")).toBe("Game One");
    expect(titles.get("gamarr-two")).toBe("Game Two");
  });

  it("returns an empty map for no markers without querying", () => {
    const { repository: reader } = repository();

    expect(reader.titlesByMarker([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/features/switch-library/repository.test.ts`
Expected: FAIL — cannot resolve module `@/features/switch-library/repository`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { downloadAttempts, games, libraryEntries } from "@/db/schema";
import type { SwitchLibraryTitleReader } from "@/features/switch-library/ports";

/**
 * Resolves on-disk directory names to real game titles.
 *
 * `download_attempts.sab_marker` is written as `gamarr-{attemptId}` for every
 * attempt regardless of source and carries a UNIQUE index, so matching a
 * directory name against it is exact rather than heuristic.
 */
export class SqliteSwitchLibraryRepository implements SwitchLibraryTitleReader {
  constructor(private readonly database: Database) {}

  titlesByMarker(markers: string[]): Map<string, string> {
    if (markers.length === 0) return new Map();
    const rows = this.database
      .select({ marker: downloadAttempts.sabMarker, title: games.title })
      .from(downloadAttempts)
      .innerJoin(
        libraryEntries,
        eq(downloadAttempts.libraryEntryId, libraryEntries.id)
      )
      .innerJoin(games, eq(libraryEntries.gameId, games.id))
      .where(inArray(downloadAttempts.sabMarker, markers))
      .all();
    return new Map(rows.map((row) => [row.marker, row.title]));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/features/switch-library/repository.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/features/switch-library/repository.ts src/features/switch-library/repository.test.ts
git commit -m "feat(switch-library): resolve attempt markers to game titles"
```

---

### Task 6: Service

**Files:**
- Create: `src/features/switch-library/service.ts`
- Test: `src/features/switch-library/service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 3.
- Produces: `class SwitchLibraryService` with `isEnabled(): boolean`, `index(): Promise<SwitchLibraryEntry[]>`, `resolve(name: string): Promise<SwitchLibraryEntry | null>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import type { SwitchLibraryFile } from "@/features/switch-library/models";
import type {
  SwitchLibraryScanner,
  SwitchLibraryTitleReader
} from "@/features/switch-library/ports";
import { SwitchLibraryService } from "@/features/switch-library/service";

function file(overrides: Partial<SwitchLibraryFile> = {}): SwitchLibraryFile {
  return {
    absolutePath: "/library/gamarr-abc/gamarr-abc.xci",
    fileName: "gamarr-abc.xci",
    parentDirName: "gamarr-abc",
    sizeBytes: 1000,
    sourceRoot: "/library",
    ...overrides
  };
}

function scannerOf(files: SwitchLibraryFile[]): SwitchLibraryScanner {
  return { scan: async () => files };
}

function titlesOf(entries: Record<string, string>): SwitchLibraryTitleReader {
  return { titlesByMarker: () => new Map(Object.entries(entries)) };
}

describe("SwitchLibraryService", () => {
  it("is disabled with no roots and scans nothing", async () => {
    let scanned = false;
    const service = new SwitchLibraryService(
      { scan: async () => { scanned = true; return []; } },
      titlesOf({}),
      []
    );

    expect(service.isEnabled()).toBe(false);
    expect(await service.index()).toEqual([]);
    expect(scanned).toBe(false);
  });

  it("names an entry after its game title when the marker resolves", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({ "gamarr-abc": "Metroid Prime 4" }),
      ["/library"]
    );

    const entries = await service.index();

    expect(entries).toEqual([{
      name: "Metroid Prime 4.xci",
      absolutePath: "/library/gamarr-abc/gamarr-abc.xci",
      sizeBytes: 1000
    }]);
  });

  it("falls back to the on-disk name when the marker does not resolve", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({}),
      ["/library"]
    );

    expect((await service.index())[0].name).toBe("gamarr-abc.xci");
  });

  it("falls back when the directory is not an attempt marker at all", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file({
        absolutePath: "/library/games/Zelda.xci",
        fileName: "Zelda.xci",
        parentDirName: "games"
      })]),
      titlesOf({}),
      ["/library"]
    );

    expect((await service.index())[0].name).toBe("Zelda.xci");
  });

  it("numbers two files that resolve to the same title", async () => {
    const service = new SwitchLibraryService(
      scannerOf([
        file({ absolutePath: "/library/gamarr-b/x.xci", parentDirName: "gamarr-b" }),
        file({ absolutePath: "/library/gamarr-a/x.xci", parentDirName: "gamarr-a" })
      ]),
      titlesOf({ "gamarr-a": "Same Game", "gamarr-b": "Same Game" }),
      ["/library"]
    );

    expect((await service.index()).map((entry) => entry.name))
      .toEqual(["Same Game (2).xci", "Same Game.xci"]);
  });

  it("sorts the finished list by name", async () => {
    const service = new SwitchLibraryService(
      scannerOf([
        file({ absolutePath: "/library/g1/z.xci", parentDirName: "g1", fileName: "z.xci" }),
        file({ absolutePath: "/library/g2/a.xci", parentDirName: "g2", fileName: "a.xci" })
      ]),
      titlesOf({}),
      ["/library"]
    );

    expect((await service.index()).map((entry) => entry.name)).toEqual(["a.xci", "z.xci"]);
  });

  it("resolves a name back to its entry", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({ "gamarr-abc": "Metroid Prime 4" }),
      ["/library"]
    );

    expect(await service.resolve("Metroid Prime 4.xci"))
      .toMatchObject({ absolutePath: "/library/gamarr-abc/gamarr-abc.xci" });
  });

  it("returns null for an unknown name", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({}),
      ["/library"]
    );

    expect(await service.resolve("../../etc/passwd")).toBeNull();
    expect(await service.resolve("Nothing.xci")).toBeNull();
  });

  it("asks for each marker only once", async () => {
    const asked: string[][] = [];
    const service = new SwitchLibraryService(
      scannerOf([
        file({ absolutePath: "/library/gamarr-abc/one.xci" }),
        file({ absolutePath: "/library/gamarr-abc/two.xci" })
      ]),
      { titlesByMarker: (markers) => { asked.push(markers); return new Map(); } },
      ["/library"]
    );

    await service.index();

    expect(asked).toEqual([["gamarr-abc"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/features/switch-library/service.test.ts`
Expected: FAIL — cannot resolve module `@/features/switch-library/service`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { SwitchLibraryEntry } from "@/features/switch-library/models";
import type {
  SwitchLibraryScanner,
  SwitchLibraryTitleReader
} from "@/features/switch-library/ports";
import {
  extensionOf,
  markerFromDirName,
  resolveDisplayNames
} from "@/features/switch-library/slug-policy";

/**
 * Composes a scan of the configured roots with the titles gamarr knows,
 * producing the list DBI browses.
 *
 * There is no cache: both entry points rescan. A cached entry can outlive the
 * file it names, so the read path would need to revalidate on open anyway —
 * which is most of the scan cost back, plus an invalidation story, for a
 * directory holding tens of files. Rescanning is self-healing instead.
 */
export class SwitchLibraryService {
  constructor(
    private readonly scanner: SwitchLibraryScanner,
    private readonly titles: SwitchLibraryTitleReader,
    private readonly roots: string[]
  ) {}

  isEnabled(): boolean {
    return this.roots.length > 0;
  }

  async index(): Promise<SwitchLibraryEntry[]> {
    if (!this.isEnabled()) return [];

    const files = await this.scanner.scan(this.roots);
    const markers = [
      ...new Set(
        files
          .map((file) => markerFromDirName(file.parentDirName))
          .filter((marker): marker is string => marker !== null)
      )
    ];
    const titles = this.titles.titlesByMarker(markers);

    const candidates = files.map((file) => {
      const marker = markerFromDirName(file.parentDirName);
      const title = marker === null ? undefined : titles.get(marker);
      return {
        absolutePath: file.absolutePath,
        preferredName:
          title === undefined ? file.fileName : `${title}${extensionOf(file.fileName)}`,
        sizeBytes: file.sizeBytes
      };
    });

    const names = resolveDisplayNames(candidates);

    return candidates
      .map((candidate) => ({
        name: names.get(candidate.absolutePath) ?? candidate.preferredName,
        absolutePath: candidate.absolutePath,
        sizeBytes: candidate.sizeBytes
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name: string): Promise<SwitchLibraryEntry | null> {
    const entries = await this.index();
    return entries.find((entry) => entry.name === name) ?? null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/features/switch-library/service.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/features/switch-library/service.ts src/features/switch-library/service.test.ts
git commit -m "feat(switch-library): compose scans and titles into the index"
```

---

### Task 7: Handlers

**Files:**
- Create: `src/app/api/dbi/handlers.ts`
- Test: `src/app/api/dbi/handlers.test.ts`

**Interfaces:**
- Consumes: `SwitchLibraryService` (Task 6), `FileOpener` / `OpenedFile` (Task 3), `parseRangeHeader` (Task 2).
- Produces: `handleDbiIndex(dependencies)`, `handleDbiFile(name, request, dependencies)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { handleDbiFile, handleDbiIndex } from "@/app/api/dbi/handlers";
import type { SwitchLibraryEntry } from "@/features/switch-library/models";
import type { FileOpener } from "@/features/switch-library/ports";

const entry: SwitchLibraryEntry = {
  name: "Metroid Prime 4.xci",
  absolutePath: "/library/gamarr-abc/gamarr-abc.xci",
  sizeBytes: 1000
};

function serviceOf(entries: SwitchLibraryEntry[], enabled = true) {
  return {
    isEnabled: () => enabled,
    index: async () => entries,
    resolve: async (name: string) => entries.find((e) => e.name === name) ?? null
  };
}

function openerOf(sizeBytes: number): FileOpener & { closed: number; ranges: number[][] } {
  const state = {
    closed: 0,
    ranges: [] as number[][],
    async open() {
      return {
        sizeBytes,
        stream(start: number, end: number) {
          state.ranges.push([start, end]);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(end - start + 1));
              controller.close();
            }
          });
        },
        close: async () => { state.closed += 1; }
      };
    }
  };
  return state as FileOpener & { closed: number; ranges: number[][] };
}

describe("handleDbiIndex", () => {
  it("404s when the feature is disabled", async () => {
    const response = await handleDbiIndex({ service: serviceOf([], false) });
    expect(response.status).toBe(404);
  });

  it("renders one anchor per entry with a percent-encoded href", async () => {
    const response = await handleDbiIndex({ service: serviceOf([entry]) });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain('<a href="Metroid%20Prime%204.xci">Metroid Prime 4.xci</a>');
  });

  it("escapes HTML metacharacters in a name", async () => {
    const response = await handleDbiIndex({
      service: serviceOf([{ ...entry, name: 'a&b"<c>.xci' }])
    });
    const body = await response.text();

    expect(body).not.toContain("<c>");
    expect(body).toContain("&amp;");
    expect(body).toContain("&lt;c&gt;");
  });

  it("renders an empty index without failing", async () => {
    const response = await handleDbiIndex({ service: serviceOf([]) });
    expect(response.status).toBe(200);
  });
});

describe("handleDbiFile", () => {
  it("404s when the feature is disabled", async () => {
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/"),
      { service: serviceOf([entry], false), opener: openerOf(1000) }
    );
    expect(response.status).toBe(404);
  });

  it("404s for an unknown name", async () => {
    const response = await handleDbiFile(
      "Nope.xci",
      new Request("http://x/"),
      { service: serviceOf([entry]), opener: openerOf(1000) }
    );
    expect(response.status).toBe(404);
  });

  it("404s when the file vanished between scan and open", async () => {
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/"),
      { service: serviceOf([entry]), opener: { open: async () => null } }
    );
    expect(response.status).toBe(404);
  });

  it("serves the whole file with Accept-Ranges when no range is asked for", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/"),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(opener.ranges).toEqual([[0, 999]]);
  });

  it("serves a 206 for a closed range", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/", { headers: { range: "bytes=100-199" } }),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(opener.ranges).toEqual([[100, 199]]);
  });

  it("serves a 206 to the end for an open-ended resume range", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/", { headers: { range: "bytes=900-" } }),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(response.headers.get("content-length")).toBe("100");
  });

  it("416s an unsatisfiable range and closes the handle", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/", { headers: { range: "bytes=5000-" } }),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
    expect(opener.closed).toBe(1);
    expect(opener.ranges).toEqual([]);
  });

  it("never leaks an absolute path in an error body", async () => {
    const response = await handleDbiFile(
      "Nope.xci",
      new Request("http://x/"),
      { service: serviceOf([entry]), opener: openerOf(1000) }
    );

    expect(await response.text()).not.toContain("/library");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/api/dbi/handlers.test.ts`
Expected: FAIL — cannot resolve module `@/app/api/dbi/handlers`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { errorResponse } from "@/app/api/error-response";
import type { SwitchLibraryEntry } from "@/features/switch-library/models";
import type { FileOpener, OpenedFile } from "@/features/switch-library/ports";
import { parseRangeHeader } from "@/features/switch-library/range";
import type { SwitchLibraryService } from "@/features/switch-library/service";
import { AppError } from "@/lib/errors";

/**
 * A disabled feature answers 404, never 403: a 403 would confirm the endpoint
 * exists. The message is deliberately generic for the same reason.
 */
function notFound(): AppError {
  return new AppError("NOT_FOUND", 404, "Not found");
}

export async function handleDbiIndex(dependencies: {
  service: Pick<SwitchLibraryService, "isEnabled" | "index">;
}): Promise<Response> {
  try {
    if (!dependencies.service.isEnabled()) throw notFound();
    const entries = await dependencies.service.index();
    return new Response(renderIndex(entries), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleDbiFile(
  name: string,
  request: Request,
  dependencies: {
    service: Pick<SwitchLibraryService, "isEnabled" | "resolve">;
    opener: FileOpener;
  }
): Promise<Response> {
  let opened: OpenedFile | null = null;
  try {
    if (!dependencies.service.isEnabled()) throw notFound();

    // `name` is only ever a lookup key. It is never joined onto a path, so a
    // traversal attempt simply misses the map and 404s.
    const entry = await dependencies.service.resolve(name);
    if (entry === null) throw notFound();

    opened = await dependencies.opener.open(entry.absolutePath);
    if (opened === null) throw notFound();

    const range = parseRangeHeader(request.headers.get("range"), opened.sizeBytes);

    if (range.kind === "unsatisfiable") {
      await opened.close();
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${opened.sizeBytes}`,
          "accept-ranges": "bytes"
        }
      });
    }

    if (opened.sizeBytes === 0) {
      await opened.close();
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "0",
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream"
        }
      });
    }

    const start = range.kind === "partial" ? range.start : 0;
    const end = range.kind === "partial" ? range.end : opened.sizeBytes - 1;

    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "cache-control": "no-store"
    };
    if (range.kind === "partial") {
      headers["content-range"] = `bytes ${start}-${end}/${opened.sizeBytes}`;
    }

    // From here the stream owns the handle and closes it on end or destroy,
    // so this path must not call close().
    return new Response(opened.stream(start, end), {
      status: range.kind === "partial" ? 206 : 200,
      headers
    });
  } catch (error) {
    if (opened !== null) {
      await opened.close().catch(() => undefined);
    }
    return errorResponse(error);
  }
}

function renderIndex(entries: SwitchLibraryEntry[]): string {
  const rows = entries
    .map(
      (entry) =>
        `<a href="${escapeHtml(encodeURIComponent(entry.name))}">${escapeHtml(entry.name)}</a><br>`
    )
    .join("\n");
  return `<!DOCTYPE html>
<html><head><title>gamarr</title></head><body>
${rows}
</body></html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/app/api/dbi/handlers.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dbi/handlers.ts src/app/api/dbi/handlers.test.ts
git commit -m "feat(api): add DBI index and file handlers with range support"
```

---

### Task 8: Wiring and documentation

**Files:**
- Create: `src/app/api/dbi/dependencies.ts`
- Create: `src/app/api/dbi/route.ts`
- Create: `src/app/api/dbi/[name]/route.ts`
- Test: `src/app/api/dbi/dependencies.test.ts`
- Modify: `CLAUDE.md` (environment variables table)
- Modify: `README.md` (environment variables table, if one exists — skip if not)

**Interfaces:**
- Consumes: everything above.
- Produces: `dbiDependencies()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

// Only the pure root parser is exercised here. Calling `dbiDependencies()`
// would construct the repository, which calls `getDatabase()` eagerly and
// opens a real SQLite file as a side effect. The wiring is covered by the
// manual verification steps instead.
import { parseLibraryRoots } from "@/app/api/dbi/dependencies";

describe("parseLibraryRoots", () => {
  it("returns no roots when unset or blank", () => {
    expect(parseLibraryRoots(undefined)).toEqual([]);
    expect(parseLibraryRoots("")).toEqual([]);
    expect(parseLibraryRoots("   ")).toEqual([]);
    expect(parseLibraryRoots(",,")).toEqual([]);
  });

  it("splits on commas and trims", () => {
    expect(parseLibraryRoots("/library, /config/downloads"))
      .toEqual(["/library", "/config/downloads"]);
  });

  it("drops relative paths, which cannot be confined", () => {
    expect(parseLibraryRoots("/library,relative/path")).toEqual(["/library"]);
  });

  it("de-duplicates repeated roots", () => {
    expect(parseLibraryRoots("/library,/library")).toEqual(["/library"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/api/dbi/dependencies.test.ts`
Expected: FAIL — cannot resolve module `@/app/api/dbi/dependencies`.

- [ ] **Step 3: Write the composition root**

```ts
import "server-only";

import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { getDatabase } from "@/db/client";
import type { FileOpener } from "@/features/switch-library/ports";
import { SqliteSwitchLibraryRepository } from "@/features/switch-library/repository";
import { SwitchLibraryService } from "@/features/switch-library/service";
import { FilesystemSwitchLibraryScanner } from "@/integrations/filesystem/switch-library-scanner";

/**
 * Relative roots are dropped rather than resolved against the process cwd:
 * a root that moves with the working directory cannot be reasoned about for
 * confinement, and silently serving the wrong tree is worse than serving none.
 */
export function parseLibraryRoots(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const roots = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "" && path.isAbsolute(value));
  return [...new Set(roots)];
}

const fileOpener: FileOpener = {
  async open(absolutePath) {
    let handle;
    try {
      handle = await open(absolutePath, "r");
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        return null;
      }
      return {
        sizeBytes: stats.size,
        stream(start, end) {
          // The stream takes ownership of the handle and closes it when it
          // ends or is destroyed.
          return Readable.toWeb(
            handle.createReadStream({ start, end, autoClose: true })
          ) as ReadableStream<Uint8Array>;
        },
        close: () => handle.close()
      };
    } catch {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      return null;
    }
  }
};

export function dbiDependencies() {
  return {
    service: new SwitchLibraryService(
      new FilesystemSwitchLibraryScanner(),
      new SqliteSwitchLibraryRepository(getDatabase()),
      parseLibraryRoots(process.env.GAMARR_SWITCH_LIBRARY_DIR)
    ),
    opener: fileOpener
  };
}
```

- [ ] **Step 4: Write the route shims**

`src/app/api/dbi/route.ts`:

```ts
import { dbiDependencies } from "@/app/api/dbi/dependencies";
import { handleDbiIndex } from "@/app/api/dbi/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleDbiIndex(dbiDependencies());
}
```

`src/app/api/dbi/[name]/route.ts`:

```ts
import { dbiDependencies } from "@/app/api/dbi/dependencies";
import { handleDbiFile } from "@/app/api/dbi/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> }
): Promise<Response> {
  const { name } = await context.params;
  // Next.js leaves the segment percent-encoded; the index emits
  // encodeURIComponent(name), so decoding here round-trips it.
  return handleDbiFile(decodeURIComponent(name), request, dbiDependencies());
}
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 6: Document the environment variable**

Add to the environment variables table in `CLAUDE.md`, after `GAMARR_DOWNLOAD_DIRECTORY`:

```markdown
| `GAMARR_SWITCH_LIBRARY_DIR` | none — feature off | Comma-separated absolute roots served at `/api/dbi` as a DBI-browsable index. Unset means both routes 404. Unauthenticated on the LAN — anything that can reach the port can enumerate and download every file under these roots. |
```

Add a short section under "Architecture" in `CLAUDE.md`:

```markdown
The DBI network install server (`/api/dbi`) serves operator-nominated roots as
an Apache-style HTML index that a Switch running DBI can install from over the
LAN, working around the FAT32 4 GiB per-file limit. It is read-only and off
unless `GAMARR_SWITCH_LIBRARY_DIR` is set. Both routes rescan on every request;
the URL segment is a lookup key against that scan and is never joined onto a
path, so there is no traversal surface.
```

- [ ] **Step 7: Commit**

```bash
git add src/app/api/dbi CLAUDE.md
git commit -m "feat(api): wire the DBI network install routes

Off unless GAMARR_SWITCH_LIBRARY_DIR names absolute roots. Relative
roots are dropped rather than resolved against cwd, since a root that
moves with the working directory cannot be reasoned about for
confinement."
```

---

## Manual verification

Not a task — run once after Task 8, on the deployment box.

1. Add the read-only mount to the gamarr service in compose:

```yaml
volumes:
  - gamarr-config:/config
  - /data/data/downloads:/library:ro
environment:
  GAMARR_SWITCH_LIBRARY_DIR: /library
```

2. `docker compose up -d gamarr`, then confirm the index lists the two `.xci`
   files and, if their attempt rows survive, under real game titles:

```bash
curl -s http://192.168.3.252:8989/api/dbi/ | grep -o '<a href="[^"]*"'
```

3. Confirm range support, which is what makes a 14.9 GiB install resumable:

```bash
curl -s -D- -o /dev/null -r 100-199 "http://192.168.3.252:8989/api/dbi/<name>"
# expect: HTTP/1.1 206, content-range: bytes 100-199/<total>, content-length: 100
```

4. Add to `switch/dbi.config` on the SD card under `[Network sources]`:

```
Gamarr=ApacheHTTP|http://192.168.3.252:8989/api/dbi/
```

The trailing slash is required. Restart DBI, open the source, install.
