import { XMLParser, XMLValidator } from "fast-xml-parser";

import type {
  NewznabSearchResult,
  PlannedQuery,
  Release
} from "@/features/release-search/models";
import { readBoundedResponse } from "@/integrations/read-bounded-response";
import { AppError } from "@/lib/errors";

interface NewznabClientOptions {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  maxItems?: number;
}

type XmlRecord = Record<string, unknown>;

export interface NewznabCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export interface NewznabCapabilities {
  serverTitle: string | null;
  serverVersion: string | null;
  searchAvailable: boolean;
  categories: NewznabCategory[];
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

export class NewznabClient {
  private readonly request: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxItems: number;

  constructor(private readonly options: NewznabClientOptions) {
    this.request = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxItems = options.maxItems ?? 1_000;
  }

  async getCapabilities(): Promise<NewznabCapabilities> {
    const url = new URL(this.options.baseUrl);
    url.searchParams.set("t", "caps");
    url.searchParams.set("o", "xml");
    url.searchParams.set("apikey", this.options.apiKey);
    const xml = await this.fetchXml(url, "capabilities");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      isArray: (name) => name === "category" || name === "subcat"
    });
    const document = asRecord(parser.parse(xml));
    const caps = asRecord(document?.caps);
    const server = asRecord(caps?.server);
    const searching = asRecord(caps?.searching);
    const search = asRecord(searching?.search);
    const categories = asRecord(caps?.categories);
    const parsedCategories: NewznabCategory[] = [];
    for (const value of list(categories?.category)) {
      const category = asRecord(value);
      const id = asText(category?.["@_id"]);
      const name = asText(category?.["@_name"]);
      if (!id || !name) continue;
      parsedCategories.push({ id, name, parentId: null });
      for (const childValue of list(category?.subcat)) {
        const child = asRecord(childValue);
        const childId = asText(child?.["@_id"]);
        const childName = asText(child?.["@_name"]);
        if (childId && childName) {
          parsedCategories.push({ id: childId, name: childName, parentId: id });
        }
      }
    }
    return {
      serverTitle: asText(server?.["@_title"]),
      serverVersion: asText(server?.["@_version"]),
      searchAvailable: String(search?.["@_available"] ?? "").toLowerCase() === "yes",
      categories: parsedCategories
    };
  }

  async search(
    query: PlannedQuery,
    signal?: AbortSignal
  ): Promise<NewznabSearchResult> {
    const url = new URL(this.options.baseUrl);
    url.searchParams.set("t", "search");
    url.searchParams.set("q", query.term);
    url.searchParams.set("o", "xml");
    url.searchParams.set("apikey", this.options.apiKey);
    if (query.categories.length > 0) {
      url.searchParams.set("cat", query.categories.join(","));
    }
    const xml = await this.fetchXml(url, "search", signal);
    return this.parse(xml);
  }

  private async fetchXml(
    url: URL,
    operation: string,
    signal?: AbortSignal
  ): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const response = await this.request(url, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal
    });
    if (!response.ok) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        `${this.options.name} ${operation} failed`
      );
    }
    const bytes = await readBoundedResponse(
      response,
      this.maxResponseBytes,
      () => new AppError(
        "UNAVAILABLE",
        502,
        `${this.options.name} response is too large`
      )
    );
    const xml = new TextDecoder().decode(bytes);
    if (XMLValidator.validate(xml) !== true) {
      throw new AppError("UNAVAILABLE", 502, `${this.options.name} returned malformed XML`);
    }
    return xml;
  }

  private parse(xml: string): NewznabSearchResult {
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
    const items = list(channel?.item).slice(0, this.maxItems);
    const releases: Release[] = [];
    const warnings: string[] = [];

    for (const value of items) {
      const item = asRecord(value);
      const enclosure = asRecord(item?.enclosure);
      const title = asText(item?.title);
      const guid = asText(item?.guid);
      const downloadUrl = typeof enclosure?.["@_url"] === "string"
        ? enclosure["@_url"]
        : null;
      if (!item || !title || !guid || !downloadUrl) {
        warnings.push("Ignored an indexer result with missing required fields");
        continue;
      }
      const attributes = list(item.attr).map(asRecord).filter(Boolean) as XmlRecord[];
      const attribute = (name: string) => attributes.find((entry) =>
        entry["@_name"] === name)?.["@_value"];
      const sizeValue = attribute("size") ?? enclosure?.["@_length"];
      const parsedSize = Number(sizeValue);
      const published = Date.parse(asText(item.pubDate) ?? "");
      releases.push({
        guid,
        title,
        indexerId: this.options.id,
        indexerName: this.options.name,
        downloadUrl,
        size: Number.isFinite(parsedSize) ? parsedSize : null,
        category: String(attribute("category") ?? asText(item.category) ?? "") || null,
        publishedAt: Number.isFinite(published) ? published : 0
      });
    }
    return { releases, warnings };
  }
}
