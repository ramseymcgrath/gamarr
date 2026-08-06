import { describe, expect, it, vi } from "vitest";

import {
  handleListCandidateFiles,
  handleReleaseSearch
} from "@/app/api/releases/handlers";
import type {
  CandidateFilesResponse,
  ReleaseSearchResponse
} from "@/features/release-search/service";
import { AppError, validationError } from "@/lib/errors";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const policy = parseOriginPolicy("http://gamarr.local");

/**
 * Builds a POST to the search route. Pass a string `body` to send it verbatim
 * (used to exercise the JSON parser), anything else is serialized. Pass
 * `origin: null` to omit the Origin header entirely.
 */
const searchRequest = (body: unknown, origin: string | null = "http://gamarr.local") =>
  new Request("http://gamarr.local/api/releases/search", {
    method: "POST",
    headers: {
      host: "gamarr.local",
      "content-type": "application/json",
      ...(origin === null ? {} : { origin })
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

describe("release search HTTP handler", () => {
  it("parses a platform-scoped search and returns opaque source references", async () => {
    // Explicitly typed: `ReleaseSearchHandlerService.search` is declared
    // `Promise<ReleaseSearchResponse | unknown>`, which collapses to
    // `Promise<unknown>` — so an untyped fake would keep compiling after a
    // field is added to the response and this test would silently stop
    // covering the wire shape. The annotation is what makes that a build
    // failure. Both `source` discriminants are pinned because
    // release-results.tsx branches on them to pick "Download" vs
    // "Send to SABnzbd".
    const searchResponse: ReleaseSearchResponse = {
      releases: [{
        title: "Game.NSW-GROUP",
        size: 4096,
        category: "games",
        publishedAt: 1_700_000_000_000,
        match: "Strong",
        score: 90,
        supportingReasons: ["Title matches"],
        conflictingReasons: [],
        sources: [
          {
            candidateId: "candidate-nzb",
            indexerName: "Indexer",
            source: "newznab"
          },
          {
            candidateId: "candidate-ia",
            indexerName: "Internet Archive",
            source: "internet-archive"
          }
        ]
      }],
      warnings: []
    };
    const search = vi.fn(async (): Promise<ReleaseSearchResponse> => searchResponse);

    const response = await handleReleaseSearch(
      searchRequest({ gameId: 1, platformId: 130 }),
      { service: { search }, policy }
    );

    // Proves the handler forwards the parsed numbers, not the raw body.
    expect(search).toHaveBeenCalledWith({ gameId: 1, platformId: 130 });
    expect(response.status).toBe(200);
    // Search mints short-lived candidate IDs, so a cached response would hand
    // out dead IDs.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      releases: [{
        title: "Game.NSW-GROUP",
        size: 4096,
        category: "games",
        publishedAt: 1_700_000_000_000,
        match: "Strong",
        score: 90,
        supportingReasons: ["Title matches"],
        conflictingReasons: [],
        sources: [
          {
            candidateId: "candidate-nzb",
            indexerName: "Indexer",
            source: "newznab"
          },
          {
            candidateId: "candidate-ia",
            indexerName: "Internet Archive",
            source: "internet-archive"
          }
        ]
      }],
      warnings: []
    });
  });

  it.each([
    { label: "a non-numeric gameId", body: { gameId: "one", platformId: 130 } },
    { label: "a non-numeric platformId", body: { gameId: 1, platformId: "x" } },
    { label: "a zero gameId", body: { gameId: 0, platformId: 130 } },
    { label: "a negative gameId", body: { gameId: -1, platformId: 130 } },
    { label: "a fractional gameId", body: { gameId: 1.5, platformId: 130 } },
    { label: "a missing gameId", body: { platformId: 130 } }
  ])("rejects $label without reaching the service", async ({ body }) => {
    const service = { search: vi.fn() };

    const response = await handleReleaseSearch(
      searchRequest(body),
      { service, policy }
    );

    expect(response.status).toBe(400);
    expect(service.search).not.toHaveBeenCalled();
  });

  it("reports malformed identifiers as a validation error", async () => {
    const service = { search: vi.fn() };

    const response = await handleReleaseSearch(
      searchRequest({ gameId: "one", platformId: 130 }),
      { service, policy }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "VALIDATION",
        message: "gameId and platformId must be positive integers"
      }
    });
  });

  // The full origin matrix (DNS rebinding, scheme/port mismatch, forwarded
  // header trust) lives in src/lib/trusted-mutation.test.ts. These two only
  // prove the guard is wired in and runs *before* body parsing and the
  // service call.
  it("rejects a cross-origin POST before reaching the service", async () => {
    const service = { search: vi.fn() };

    const response = await handleReleaseSearch(
      searchRequest({ gameId: 1, platformId: 130 }, "http://attacker.test"),
      { service, policy }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Request origin is not allowed" }
    });
    expect(service.search).not.toHaveBeenCalled();
  });

  it("rejects a POST with no origin when no automation token is configured", async () => {
    const service = { search: vi.fn() };

    const response = await handleReleaseSearch(
      searchRequest({ gameId: 1, platformId: 130 }, null),
      { service, policy }
    );

    expect(response.status).toBe(403);
    expect(service.search).not.toHaveBeenCalled();
  });

  it("flattens a JSON parse failure into a generic 500", async () => {
    // `request.json()` throws a SyntaxError, which is not an AppError, so
    // errorResponse must flatten it — raw upstream error text must never
    // reach the client.
    const service = { search: vi.fn() };

    const response = await handleReleaseSearch(
      searchRequest("not json"),
      { service, policy }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL", message: "Unexpected server error" }
    });
    expect(service.search).not.toHaveBeenCalled();
  });
});

const filesRequest = (candidateId: string | null) => new Request(
  `http://gamarr.local/api/releases/files${
    candidateId === null ? "" : `?candidateId=${candidateId}`
  }`
);

/**
 * Which files are selectable — original-vs-derivative preference, unsafe-name
 * filtering, ordering, the cap, and the `{name, size, format}` projection — is
 * release-search domain policy and is covered by
 * src/features/release-search/file-selection.test.ts. The candidate lookup and
 * its 404/400 rejections are covered by service.test.ts. What remains here is
 * only the handler's own job: read the query parameter, delegate, and shape
 * the response.
 */
describe("handleListCandidateFiles", () => {
  it("returns the service's listing verbatim and forbids caching", async () => {
    const listCandidateFiles = vi.fn(async (): Promise<CandidateFilesResponse> => ({
      files: [
        { name: "big.zip", size: 20, format: "ZIP" },
        { name: "unknown.bin", size: null, format: "Binary" }
      ],
      torrent: { name: "game_archive.torrent", size: 42 },
      torrentClientConfigured: true
    }));

    const response = await handleListCandidateFiles(
      filesRequest("candidate-ia"),
      { service: { listCandidateFiles } }
    );

    // Proves the handler forwards the parsed parameter, not the whole URL.
    expect(listCandidateFiles).toHaveBeenCalledWith("candidate-ia");
    expect(response.status).toBe(200);
    // Candidates expire after 30 minutes, so a cached listing would describe
    // an item the caller can no longer download from.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      files: [
        { name: "big.zip", size: 20, format: "ZIP" },
        { name: "unknown.bin", size: null, format: "Binary" }
      ],
      torrent: { name: "game_archive.torrent", size: 42 },
      torrentClientConfigured: true
    });
  });

  it("rejects a request with no candidateId parameter", async () => {
    const listCandidateFiles = vi.fn();

    const response = await handleListCandidateFiles(
      filesRequest(null),
      { service: { listCandidateFiles } }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "VALIDATION", message: "candidateId is required" }
    });
    expect(listCandidateFiles).not.toHaveBeenCalled();
  });

  it("rejects an empty candidateId parameter", async () => {
    const listCandidateFiles = vi.fn();

    const response = await handleListCandidateFiles(
      filesRequest(""),
      { service: { listCandidateFiles } }
    );

    expect(response.status).toBe(400);
    expect(listCandidateFiles).not.toHaveBeenCalled();
  });

  it("surfaces an expired or unknown candidate as a 404", async () => {
    const response = await handleListCandidateFiles(
      filesRequest("candidate-ia"),
      {
        service: {
          listCandidateFiles: vi.fn(async () => {
            throw new AppError("NOT_FOUND", 404, "Release candidate has expired");
          })
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Release candidate has expired" }
    });
  });

  it("surfaces a non-Internet-Archive candidate as a 400", async () => {
    const response = await handleListCandidateFiles(
      filesRequest("candidate-nzb"),
      {
        service: {
          listCandidateFiles: vi.fn(async () => {
            throw validationError("Candidate is not an Internet Archive item");
          })
        }
      }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    // Exact equality, not a subset: the handler must not decorate the error
    // envelope with anything derived from the rejected candidate.
    expect(body).toEqual({
      error: {
        code: "VALIDATION",
        message: "Candidate is not an Internet Archive item"
      }
    });
  });

  it("flattens an upstream listing failure into a generic 500", async () => {
    const response = await handleListCandidateFiles(
      filesRequest("candidate-ia"),
      {
        service: {
          listCandidateFiles: vi.fn(async () => {
            throw new Error("archive.org rejected token=ia-secret-token");
          })
        }
      }
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: { code: "INTERNAL", message: "Unexpected server error" }
    });
    expect(JSON.stringify(body)).not.toContain("ia-secret-token");
  });
});
