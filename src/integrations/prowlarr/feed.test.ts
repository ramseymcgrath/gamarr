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
