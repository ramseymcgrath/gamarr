import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  handleProwlarrFixture,
  prowlarrTorrentPayload
} from "@tests/provider-server/prowlarr-fixtures";
import { fixtureState } from "@tests/provider-server/state";

const port = Number(process.env.GAMARR_FIXTURE_PORT ?? 4100);

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

/**
 * qBittorrent 5.x names its session cookie `QBT_SID_<webui-port>`, not the
 * bare `SID` the WebUI documentation describes. The fixture uses the real
 * name so the e2e run exercises the same parsing path a current server hits —
 * a fixture that answered `SID` would keep passing even if the client
 * regressed to matching only the documented name.
 */
const sessionCookie = `QBT_SID_${port}=fixture-sid`;

function hasQbittorrentSession(request: IncomingMessage): boolean {
  const cookies = request.headers.cookie?.split(";").map((value) => value.trim());
  return cookies?.includes(sessionCookie) === true &&
    request.headers.referer === `http://127.0.0.1:${port}`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/health") return json(response, { status: "ok" });
  if (url.pathname === "/reset") {
    fixtureState.reset();
    return json(response, { status: "ok" });
  }
  const prowlarr = handleProwlarrFixture({
    method: request.method,
    url,
    apiKey: Array.isArray(request.headers["x-api-key"])
      ? request.headers["x-api-key"][0]
      : request.headers["x-api-key"]
  });
  if (prowlarr !== null) {
    response.writeHead(prowlarr.status, prowlarr.headers);
    return response.end(prowlarr.body);
  }
  if (url.pathname === "/oauth2/token") {
    return json(response, {
      access_token: "fixture-access-token",
      expires_in: 3600,
      token_type: "bearer"
    });
  }
  if (url.pathname.endsWith("/platforms")) {
    return json(response, [
      { id: 130, name: "Nintendo Switch", abbreviation: "Switch", generation: 8 },
      { id: 167, name: "PlayStation 5", abbreviation: "PS5", generation: 9 },
      { id: 169, name: "Xbox Series X|S", abbreviation: "XSX", generation: 9 },
      { id: 6, name: "PC (Microsoft Windows)", abbreviation: "PC" }
    ]);
  }
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
  if (url.pathname === "/sab/api") {
    const mode = url.searchParams.get("mode");
    if (request.method === "POST") {
      const payload = (await body(request)).toString("utf8");
      const marker = payload.match(/name="nzbname"\r\n\r\n([^\r\n]+)/)?.[1] ??
        "gamarr-fixture";
      const jobId = `SABnzbd_nzo_${fixtureState.jobs.length + 1}`;
      fixtureState.jobs.push({
        jobId,
        marker,
        status: "Queued",
        progress: 0
      });
      return json(response, { status: true, nzo_ids: [jobId] });
    }
    if (mode === "history") {
      return json(response, { history: { slots: [] } });
    }
    return json(response, {
      queue: {
        slots: fixtureState.jobs.map((job) => ({
          nzo_id: job.jobId,
          filename: job.marker,
          status: job.status,
          percentage: String(job.progress)
        }))
      }
    });
  }
  if (
    request.method === "POST" &&
    url.pathname === "/qbittorrent/api/v2/auth/login"
  ) {
    const credentials = new URLSearchParams((await body(request)).toString("utf8"));
    if (
      credentials.get("username") !== "fixture-user" ||
      credentials.get("password") !== "fixture-password"
    ) {
      response.writeHead(403, { "content-type": "text/plain" });
      return response.end("Fails.");
    }
    // 204 with no body, matching qBittorrent 5.x. The documented `200` plus
    // an `Ok.` body is what 4.x returned. The `expires` attribute carries a
    // comma on purpose: a parser that splits set-cookie on commas breaks here.
    response.writeHead(204, {
      "set-cookie":
        `${sessionCookie}; HttpOnly; SameSite=Lax; `
        + "expires=Tue, 04 Aug 2026 18:06:55 GMT; path=/"
    });
    return response.end();
  }
  if (
    request.method === "POST" &&
    url.pathname === "/qbittorrent/api/v2/torrents/add"
  ) {
    if (!hasQbittorrentSession(request)) {
      return json(response, { error: "forbidden" }, 403);
    }
    const payload = (await body(request)).toString("utf8");
    const tag = payload.match(/name="tags"\r\n\r\n([^\r\n]+)/)?.[1] ?? "";
    if (
      tag.length === 0 ||
      !payload.includes('name="torrents"; filename="') ||
      !payload.includes(prowlarrTorrentPayload.toString("utf8"))
    ) {
      return json(response, { error: "invalid torrent" }, 415);
    }
    fixtureState.torrent = { tag, polls: 0 };
    return json(response, {
      added_torrent_ids: ["abc123"],
      success_count: 1,
      pending_count: 0,
      failure_count: 0
    });
  }
  if (
    request.method === "GET" &&
    url.pathname === "/qbittorrent/api/v2/torrents/info"
  ) {
    if (!hasQbittorrentSession(request)) {
      return json(response, { error: "forbidden" }, 403);
    }
    if (fixtureState.torrent === null) return json(response, []);
    fixtureState.torrent.polls += 1;
    const complete = fixtureState.torrent.polls >= 2;
    return json(response, [{
      hash: "abc123",
      tags: fixtureState.torrent.tag,
      state: complete ? "uploading" : "downloading",
      progress: complete ? 1 : 0.5,
      name: "metroid-prime-4-beyond-usa",
      size: 2048
    }]);
  }
  json(response, { error: "not found" }, 404);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Gamarr fixture providers listening on ${port}\n`);
});
