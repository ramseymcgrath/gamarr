import { lookup } from "node:dns/promises";

import * as ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, interceptors } from "undici";

import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
import { readBoundedResponse } from "@/integrations/read-bounded-response";
import { validateMagnet } from "@/integrations/prowlarr/magnet-policy";
import { validateDownloadUrl } from "@/integrations/prowlarr/url-policy";
import { AppError } from "@/lib/errors";

interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveHostname = (
  hostname: string
) => Promise<readonly ResolvedAddress[]>;

interface ResponseLease {
  response: Response;
  release(): Promise<void>;
}

export type PinnedRequest = (
  target: URL,
  init: RequestInit,
  addresses: readonly ResolvedAddress[]
) => Promise<ResponseLease>;

const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

const requestWithPinnedDns: PinnedRequest = async (target, init, addresses) => {
  const records = addresses.map(({ address }) => ({
    address,
    family: ipaddr.process(address).kind() === "ipv6" ? 6 as const : 4 as const,
    ttl: 1
  }));
  const dispatcher = new Agent().compose(interceptors.dns({
    maxTTL: 1,
    lookup: (_origin, _options, callback) => callback(null, records)
  }));
  try {
    const response = await undiciFetch(target, {
      headers: init.headers,
      redirect: "manual",
      signal: init.signal ?? undefined,
      dispatcher
    });
    return {
      response: response as unknown as Response,
      release: () => dispatcher.close()
    };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
};

export type FetchedRelease =
  | { kind: "nzb"; bytes: Uint8Array }
  | { kind: "torrent"; bytes: Uint8Array }
  | { kind: "magnet"; uri: string };

export interface ProwlarrFetcherOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  resolve?: ResolveHostname;
  pinnedRequest?: PinnedRequest;
}

export class ProwlarrFetcher {
  private readonly request: typeof fetch;
  private readonly resolve: ResolveHostname;
  private readonly pinnedRequest: PinnedRequest;

  constructor(private readonly options: ProwlarrFetcherOptions) {
    this.request = options.fetch ?? fetch;
    this.resolve = options.resolve ?? resolveHostname;
    this.pinnedRequest = options.pinnedRequest ?? requestWithPinnedDns;
  }

  async fetch(input: {
    candidate: ReleaseCandidateRecord;
    magnetUrl: string | null;
    maxBytes: number;
  }): Promise<FetchedRelease> {
    if (input.magnetUrl !== null) {
      return {
        kind: "magnet",
        uri: validateMagnet(input.magnetUrl, this.options.apiKey)
      };
    }

    const configured = new URL(this.options.baseUrl);
    const safeTarget = validateDownloadUrl(
      this.options.baseUrl,
      input.candidate.downloadPath
    );
    const approvedRedirectOrigin = this.getApprovedRedirectOrigin(
      input.candidate.guid
    );
    let target = new URL(safeTarget.downloadPath, configured);
    let externalOrigin: string | null = null;
    if (target.origin !== configured.origin) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Release URL left the configured Prowlarr origin"
      );
    }

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let lease: ResponseLease;
      if (externalOrigin) {
        const addresses = await this.assertPublicRedirectTarget(
          target,
          externalOrigin
        );
        lease = await this.pinnedRequest(
          target,
          this.requestInit(false),
          addresses
        );
      } else {
        lease = {
          response: await this.request(target, this.requestInit(true)),
          release: async () => undefined
        };
      }
      const response = lease.response;
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirects === 3) {
            throw new AppError(
              "UNAVAILABLE",
              502,
              "Prowlarr returned an invalid redirect"
            );
          }
          if (location.startsWith("magnet:")) {
            return {
              kind: "magnet",
              uri: validateMagnet(location, this.options.apiKey)
            };
          }
          const redirected = new URL(location, target);
          if (redirected.username || redirected.password || redirected.hash) {
            throw new AppError(
              "UNAVAILABLE",
              502,
              "Prowlarr returned an unsafe redirect"
            );
          }
          this.removeIndexerCredentials(redirected, this.options.apiKey);
          if (externalOrigin && redirected.origin !== externalOrigin) {
            throw new AppError(
              "UNAVAILABLE",
              502,
              "Prowlarr redirected the release payload to another origin"
            );
          }
          if (
            !externalOrigin
            && redirected.origin !== configured.origin
            && redirected.origin !== approvedRedirectOrigin
          ) {
            throw new AppError(
              "UNAVAILABLE",
              502,
              "Prowlarr redirected the release payload to another origin"
            );
          }
          if (redirected.origin !== configured.origin) {
            externalOrigin = redirected.origin;
          }
          target = redirected;
          continue;
        }
        if (!response.ok || !response.body) {
          throw new AppError(
            "UNAVAILABLE",
            502,
            "Prowlarr release payload retrieval failed"
          );
        }
        const bytes = await readBoundedResponse(
          response,
          input.maxBytes,
          () => new AppError(
            "UNAVAILABLE",
            502,
            "Prowlarr release payload exceeded the size limit"
          )
        );
        return this.protocolOf(input.candidate) === "torrent"
          ? { kind: "torrent", bytes }
          : { kind: "nzb", bytes };
      } finally {
        if (response.body && !response.bodyUsed) {
          await response.body.cancel().catch(() => undefined);
        }
        await lease.release();
      }
    }
    throw new AppError(
      "UNAVAILABLE",
      502,
      "Prowlarr redirect limit exceeded"
    );
  }

  private requestInit(includeApiKey: boolean): RequestInit {
    const headers: Record<string, string> = {
      accept: [
        "application/x-nzb",
        "application/x-bittorrent",
        "application/xml",
        "text/xml"
      ].join(", ")
    };
    if (includeApiKey) headers["x-api-key"] = this.options.apiKey;
    return {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 10_000))
    };
  }

  private protocolOf(
    candidate: ReleaseCandidateRecord
  ): "usenet" | "torrent" {
    // Task 9 replaces the legacy `source` field with this protocol field. The
    // runtime guard keeps this Task 6 adapter safe while both shapes coexist.
    const protocol = (
      candidate as ReleaseCandidateRecord & { protocol?: unknown }
    ).protocol;
    if (protocol === "usenet" || protocol === "torrent") return protocol;
    throw new AppError(
      "UNAVAILABLE",
      502,
      "Prowlarr release protocol is invalid"
    );
  }

  private getApprovedRedirectOrigin(guid: string): string | null {
    try {
      const target = new URL(guid);
      if (
        target.protocol !== "https:"
        || target.username
        || target.password
        || target.hash
      ) {
        return null;
      }
      return target.origin;
    } catch {
      return null;
    }
  }

  private async assertPublicRedirectTarget(
    target: URL,
    approvedOrigin: string
  ): Promise<readonly ResolvedAddress[]> {
    if (
      target.protocol !== "https:"
      || target.origin !== approvedOrigin
      || target.username
      || target.password
      || target.hash
    ) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr returned an unsafe redirect"
      );
    }

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.resolve(target.hostname.replace(/^\[|\]$/g, ""));
    } catch {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr redirect host could not be resolved"
      );
    }
    if (
      addresses.length === 0
      || addresses.some(({ address }) =>
        !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast"
      )
    ) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr redirected the release payload to a non-public address"
      );
    }
    return addresses;
  }

  private removeIndexerCredentials(target: URL, apiKey: string): void {
    let decodedPath = target.pathname;
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr returned an unsafe redirect"
      );
    }
    if (
      apiKey.length > 0
      && (
        decodedPath.includes(apiKey)
        || [...target.searchParams.values()].some((value) => value.includes(apiKey))
      )
    ) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr redirect exposed the configured API credential"
      );
    }

    const credentialNames = new Set(["apikey", "api_key", "key"]);
    for (const name of [...target.searchParams.keys()]) {
      if (credentialNames.has(name.toLowerCase())) {
        target.searchParams.delete(name);
      }
    }
  }
}
