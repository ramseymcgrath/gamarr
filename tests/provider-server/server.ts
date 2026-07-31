import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

function xml(response: ServerResponse, value: string) {
  response.writeHead(200, { "content-type": "application/xml" });
  response.end(value);
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
  json(response, { error: "not found" }, 404);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Gamarr fixture providers listening on ${port}\n`);
});
