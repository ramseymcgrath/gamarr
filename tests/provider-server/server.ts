import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { fixtureState } from "@tests/provider-server/state";

const port = Number(process.env.GAMARR_FIXTURE_PORT ?? 4100);
const torrentPayload = Buffer.from("gamarr-fixture-torrent-bytes");

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

function xml(response: ServerResponse, value: string) {
  response.writeHead(200, { "content-type": "application/xml" });
  response.end(value);
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
  if (url.pathname === "/newznab/api") {
    const mode = url.searchParams.get("t");
    if (mode === "caps") {
      return xml(response, `<?xml version="1.0"?>
        <caps>
          <server version="1" title="Fixture Newznab" />
          <searching><search available="yes" /></searching>
          <categories>
            <category id="4000" name="PC">
              <subcat id="4050" name="Games" />
            </category>
          </categories>
        </caps>`);
    }
    if (mode === "get") {
      response.writeHead(200, { "content-type": "application/x-nzb" });
      return response.end(`<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><head /></nzb>`);
    }
    return xml(response, `<?xml version="1.0"?>
      <rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/" version="2.0">
        <channel>
          <item>
            <title>Metroid.Prime.4.Beyond.NSW-GAMARR</title>
            <guid isPermaLink="false">fixture-guid</guid>
            <pubDate>Thu, 31 Jul 2026 00:00:00 GMT</pubDate>
            <enclosure url="http://127.0.0.1:${port}/newznab/api?t=get&amp;id=fixture-guid&amp;apikey=indexer-secret" length="2147483648" type="application/x-nzb" />
            <newznab:attr name="category" value="4050" />
            <newznab:attr name="size" value="2147483648" />
          </item>
        </channel>
      </rss>`);
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
      !payload.includes(torrentPayload.toString("utf8"))
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
  if (url.pathname === "/advancedsearch.php") {
    return json(response, {
      response: {
        docs: [{
          identifier: "metroid-prime-4-beyond-usa",
          title: "Metroid Prime 4: Beyond (USA)",
          date: "2026-07-31T00:00:00Z",
          downloads: 1234,
          item_size: 2048
        }]
      }
    });
  }
  if (url.pathname.startsWith("/metadata/")) {
    const identifier = url.pathname.slice("/metadata/".length);
    return json(response, {
      files: [
        {
          name: "Metroid.Prime.4.Beyond.(USA).zip",
          size: "512",
          format: "ZIP",
          source: "original"
        },
        {
          name: "Metroid.Prime.4.Beyond.(USA).chd",
          size: "2048",
          format: "CHD",
          source: "original"
        },
        {
          name: `${identifier}_archive.torrent`,
          size: String(torrentPayload.length),
          format: "Archive BitTorrent",
          source: "metadata"
        },
        {
          name: "metroid-prime-4-beyond-usa_files.xml",
          size: "128",
          format: "Metadata",
          source: "metadata"
        }
      ]
    });
  }
  if (url.pathname.startsWith("/download/")) {
    const segments = url.pathname.split("/").filter(Boolean);
    const identifier = segments[1];
    const fileName = segments[2];
    if (fileName === `${identifier}_archive.torrent`) {
      response.writeHead(200, {
        "content-type": "application/x-bittorrent",
        "content-length": String(torrentPayload.length)
      });
      return response.end(torrentPayload);
    }
    const payload = Buffer.from("gamarr-fixture-rom-bytes");
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(payload.length)
    });
    return response.end(payload);
  }
  json(response, { error: "not found" }, 404);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Gamarr fixture providers listening on ${port}\n`);
});
