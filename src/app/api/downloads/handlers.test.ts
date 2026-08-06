import { describe, expect, it, vi } from "vitest";

import {
  handleReconcileDownloads,
  handleSubmitDownload
} from "@/app/api/downloads/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const attempt = {
  id: "attempt",
  libraryEntryId: "library",
  submissionKey: "private-key",
  requestFingerprint: "private-fingerprint",
  status: "Queued" as const,
  source: "newznab" as const,
  releaseTitle: "Game.NSW",
  indexerId: "indexer",
  indexerNameSnapshot: "Indexer",
  indexerUrlSnapshot: "https://indexer.test",
  newznabGuid: "guid",
  iaFileName: null,
  torrentHash: null,
  size: 123,
  category: "games",
  sabnzbdConfigRevision: 1,
  sabMarker: "gamarr-attempt",
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

  it("rejects an unknown delivery value", async () => {
    const submit = vi.fn(async () => attempt);
    const response = await handleSubmitDownload(
      request("/api/downloads", {
        submissionKey: "key",
        candidateId: "candidate",
        gameId: 1,
        platformId: 130,
        delivery: "magnet"
      }),
      {
        service: { submit, reconcile: vi.fn() },
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(400);
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
