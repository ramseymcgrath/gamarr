export const prowlarrApiKey = "fixture-prowlarr-key";

const torrentFileName = "Metroid.Prime.4.Beyond.NSW-GAMARR.nsp";
export const prowlarrTorrentPayload = Buffer.from(
  `d4:infod6:lengthi2048e4:name37:${torrentFileName}ee`
);

interface ProwlarrFixtureRequest {
  method: string | undefined;
  url: URL;
  apiKey: string | undefined;
}

export interface ProwlarrFixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

function json(value: unknown, status = 200): ProwlarrFixtureResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  };
}

function xml(value: string): ProwlarrFixtureResponse {
  return {
    status: 200,
    headers: { "content-type": "application/xml" },
    body: value
  };
}

function feed(indexerId: string, origin: string): ProwlarrFixtureResponse {
  const torrent = indexerId === "7";
  const link = torrent ? "fixture-torrent" : "fixture-nzb";
  const enclosureType = torrent
    ? "application/x-bittorrent"
    : "application/x-nzb";
  const health = torrent
    ? `
        <torznab:attr name="seeders" value="42" />
        <torznab:attr name="peers" value="48" />`
    : "";
  return xml(`<?xml version="1.0"?>
    <rss xmlns:torznab="http://torznab.com/schemas/2015/feed" version="2.0">
      <channel>
        <item>
          <title>Metroid.Prime.4.Beyond.NSW-GAMARR</title>
          <guid isPermaLink="false">fixture-${torrent ? "torrent" : "usenet"}-guid</guid>
          <pubDate>Tue, 11 Aug 2026 00:00:00 GMT</pubDate>
          <enclosure
            url="${origin}/api/v1/indexer/${indexerId}/download?link=${link}"
            length="2048"
            type="${enclosureType}"
          />${health}
          <torznab:attr name="category" value="1000" />
          <torznab:attr name="size" value="2048" />
        </item>
      </channel>
    </rss>`);
}

export function handleProwlarrFixture(
  request: ProwlarrFixtureRequest
): ProwlarrFixtureResponse | null {
  if (!request.url.pathname.startsWith("/api/v1/indexer")) return null;
  if (request.apiKey !== prowlarrApiKey) {
    return json({ error: "unauthorized" }, 401);
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  if (request.url.pathname === "/api/v1/indexer") {
    return json([
      {
        id: 7,
        name: "Fixture Torrent",
        protocol: "torrent",
        enable: true,
        priority: 10,
        capabilities: { categories: [{ id: 1000, name: "Console" }] }
      },
      {
        id: 3,
        name: "Fixture Usenet",
        protocol: "usenet",
        enable: true,
        priority: 20,
        capabilities: { categories: [{ id: 1000, name: "Console" }] }
      }
    ]);
  }

  const route = request.url.pathname.match(
    /^\/api\/v1\/indexer\/([^/]+)\/(newznab|download)$/
  );
  if (route === null || (route[1] !== "7" && route[1] !== "3")) {
    return json({ error: "not found" }, 404);
  }
  const [, indexerId, operation] = route;
  if (operation === "newznab") return feed(indexerId!, request.url.origin);

  const link = request.url.searchParams.get("link");
  if (indexerId === "7" && link === "fixture-torrent") {
    return {
      status: 200,
      headers: {
        "content-type": "application/x-bittorrent",
        "content-length": String(prowlarrTorrentPayload.length)
      },
      body: prowlarrTorrentPayload
    };
  }
  if (indexerId === "7" && link === "fixture-magnet") {
    return {
      status: 302,
      headers: {
        location: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
      },
      body: ""
    };
  }
  if (indexerId === "3" && link === "fixture-nzb") {
    return {
      status: 200,
      headers: { "content-type": "application/x-nzb" },
      body: "<?xml version=\"1.0\"?><nzb xmlns=\"http://www.newzbin.com/DTD/2003/nzb\"><head /></nzb>"
    };
  }
  return json({ error: "not found" }, 404);
}
