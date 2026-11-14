import { describe, expect, it, vi } from "vitest";

import {
  handleReconcileDownloads,
  handleSubmitDownload,
  handleVerifyDownload,
  toPublicAttempt
} from "@/app/api/downloads/handlers";
import type { DownloadVerification } from "@/features/verification/models";
import { AppError } from "@/lib/errors";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const attempt = {
  id: "attempt",
  libraryEntryId: "library",
  submissionKey: "private-key",
  requestFingerprint: "private-fingerprint",
  status: "Queued" as const,
  source: "prowlarr-usenet" as const,
  releaseTitle: "Game.NSW",
  indexerId: "indexer",
  indexerNameSnapshot: "Indexer",
  indexerUrlSnapshot: "https://indexer.test",
  newznabGuid: "guid",
  iaFileName: null,
  torrentHash: null,
  selectedFiles: null,
  filesAppliedAt: null,
  size: 123,
  category: "games",
  sabnzbdConfigRevision: 1,
  marker: "gamarr-attempt",
  sabJobId: "job",
  progress: 0,
  failureDetail: null,
  sabRequestStartedAt: 1,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null
};

const request = (path: string, body: unknown) => new Request(
  `http://gamarr.local${path}`,
  {
    method: "POST",
    headers: {
      host: "gamarr.local",
      origin: "http://gamarr.local",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }
);

describe("download HTTP handlers", () => {
  it("submits an opaque candidate and redacts internal submission state", async () => {
    const submit = vi.fn(async () => attempt);
    const response = await handleSubmitDownload(
      request("/api/downloads", {
        submissionKey: "key",
        candidateId: "candidate",
        gameId: 1,
        platformId: 130
      }),
      {
        service: { submit, reconcile: vi.fn() },
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledWith({
      submissionKey: "key",
      candidateId: "candidate",
      gameId: 1,
      platformId: 130
    });
    expect(JSON.stringify(body)).not.toContain("indexer.test");
    expect(JSON.stringify(body)).not.toContain("private-fingerprint");
    expect(body).toMatchObject({ id: "attempt", status: "Queued" });
  });

  it("forwards selected torrent file indices", async () => {
    const submit = vi.fn(async () => attempt);
    const response = await handleSubmitDownload(
      request("/api/downloads", {
        submissionKey: "key",
        candidateId: "candidate",
        gameId: 1,
        platformId: 130,
        selectedFiles: [0, 2]
      }),
      {
        service: { submit, reconcile: vi.fn() },
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledWith({
      submissionKey: "key",
      candidateId: "candidate",
      gameId: 1,
      platformId: 130,
      selectedFiles: [0, 2]
    });
  });

  it("rejects an invalid selected-file list", async () => {
    const submit = vi.fn(async () => attempt);
    const response = await handleSubmitDownload(
      request("/api/downloads", {
        submissionKey: "key",
        candidateId: "candidate",
        gameId: 1,
        platformId: 130,
        selectedFiles: [0, -1]
      }),
      {
        service: { submit, reconcile: vi.fn() },
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin mutation", async () => {
    const submit = vi.fn(async () => attempt);
    const untrusted = new Request("http://gamarr.local/api/downloads", {
      method: "POST",
      headers: {
        host: "gamarr.local",
        origin: "http://attacker.test",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        submissionKey: "key",
        candidateId: "candidate",
        gameId: 1,
        platformId: 130
      })
    });

    const response = await handleSubmitDownload(untrusted, {
      service: { submit, reconcile: vi.fn() },
      policy: parseOriginPolicy("http://gamarr.local")
    });

    expect(response.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reconciles only requested attempt IDs behind the mutation guard", async () => {
    const reconcile = vi.fn(async () => [attempt]);
    const response = await handleReconcileDownloads(
      request("/api/downloads/reconcile", { ids: ["attempt"] }),
      {
        service: { submit: vi.fn(), reconcile },
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(["attempt"]);
  });
});

describe("download verification HTTP", () => {
  const policy = parseOriginPolicy("http://gamarr.local");
  const verification: DownloadVerification = {
    attemptId: "attempt",
    status: "Verified",
    fileName: "Guitar Hero II (USA).iso",
    sha1: "abc",
    serial: "SLUS-21447",
    redumpName: "Guitar Hero II (USA)",
    detail: "Matches Redump",
    requestedAt: 1,
    checkedAt: 2,
    updatedAt: 2
  };

  it("queues a check and returns its public state", async () => {
    const service = { request: vi.fn(() => ({ ...verification, status: "Pending" as const })) };
    const response = await handleVerifyDownload(
      request("/api/downloads/attempt/verify", {}),
      "attempt",
      { service, policy }
    );
    expect(response.status).toBe(202);
    expect(service.request).toHaveBeenCalledWith("attempt");
    const body = await response.json();
    expect(body.status).toBe("Pending");
    expect(body).not.toHaveProperty("attemptId");
  });

  it("rejects an untrusted origin before queuing", async () => {
    const service = { request: vi.fn() };
    const response = await handleVerifyDownload(
      new Request("http://gamarr.local/api/downloads/attempt/verify", {
        method: "POST",
        headers: { host: "gamarr.local", origin: "https://evil.example" }
      }),
      "attempt",
      { service, policy }
    );
    expect(response.status).toBe(403);
    expect(service.request).not.toHaveBeenCalled();
  });

  it("maps service errors to their status", async () => {
    const service = {
      request: vi.fn(() => {
        throw new AppError("VALIDATION", 400, "Only completed downloads can be verified");
      })
    };
    const response = await handleVerifyDownload(
      request("/api/downloads/attempt/verify", {}),
      "attempt",
      { service, policy }
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.message)
      .toBe("Only completed downloads can be verified");
  });

  it("includes verification in the public attempt, or null", () => {
    expect(toPublicAttempt(attempt).verification).toBeNull();
    expect(toPublicAttempt(attempt, verification).verification).toEqual({
      status: "Verified",
      fileName: "Guitar Hero II (USA).iso",
      serial: "SLUS-21447",
      redumpName: "Guitar Hero II (USA)",
      sha1: "abc",
      detail: "Matches Redump",
      checkedAt: 2
    });
  });
});
