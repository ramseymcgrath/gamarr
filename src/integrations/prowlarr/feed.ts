import { XMLParser, XMLValidator } from "fast-xml-parser";

import { AppError } from "@/lib/errors";

type XmlRecord = Record<string, unknown>;

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

function asRecord(value: unknown): XmlRecord | null {
  return value && typeof value === "object" ? value as XmlRecord : null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  const record = asRecord(value);
  const text = record?.["#text"];
  return typeof text === "string" || typeof text === "number"
    ? String(text)
    : null;
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function numericAttribute(value: unknown): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

export function parseFeed(
  xml: string,
  indexer: FeedIndexer,
  maxItems = 1_000
): ParsedFeed {
  if (XMLValidator.validate(xml) !== true) {
    throw new AppError("UNAVAILABLE", 502, "Indexer returned malformed XML");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (_name, path) => typeof path === "string" &&
      (path.endsWith(".item") || path.endsWith(".attr"))
  });
  const document = asRecord(parser.parse(xml));
  const rss = asRecord(document?.rss);
  const channel = asRecord(rss?.channel);
  const items = list(channel?.item).slice(0, maxItems);
  const releases: FeedRelease[] = [];
  const warnings: string[] = [];

  for (const value of items) {
    const item = asRecord(value);
    const enclosure = asRecord(item?.enclosure);
    const title = asText(item?.title);
    const guid = asText(item?.guid);
    const attributes = list(item?.attr).map(asRecord).filter(Boolean) as XmlRecord[];
    const attribute = (name: string) => attributes.find((entry) =>
      entry["@_name"] === name)?.["@_value"];
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
    if (!item || !title || !guid || !downloadUrl) {
      warnings.push("Ignored an indexer result with missing required fields");
      continue;
    }
    const sizeValue = attribute("size") ?? enclosure?.["@_length"];
    const parsedSize = Number(sizeValue);
    const published = Date.parse(asText(item.pubDate) ?? "");
    releases.push({
      guid,
      title,
      protocol: indexer.protocol,
      indexerId: indexer.id,
      indexerName: indexer.name,
      downloadUrl,
      magnetUrl,
      seeders: numericAttribute(attribute("seeders")),
      peers: numericAttribute(attribute("peers")),
      size: Number.isFinite(parsedSize) ? parsedSize : null,
      category: String(attribute("category") ?? asText(item.category) ?? "") || null,
      // `null`, not 0: an unparseable pubDate must not render as 1970.
      publishedAt: Number.isFinite(published) ? published : null
    });
  }
  return { releases, warnings };
}
