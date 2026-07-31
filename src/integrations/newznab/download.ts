import { lookup } from "node:dns/promises";

import * as ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, interceptors } from "undici";

import type { NzbFetcherPort } from "@/features/downloads/port";
import { readBoundedResponse } from "@/integrations/read-bounded-response";
import { AppError } from "@/lib/errors";

interface ResolvedAddress {
  address: string;
  family: number;
}

type ResolveHostname = (hostname: string) => Promise<readonly ResolvedAddress[]>;

interface ResponseLease {
  response: Response;
  release(): Promise<void>;
}

type PinnedRequest = (
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

export class NewznabNzbFetcher implements NzbFetcherPort {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly resolve: ResolveHostname = resolveHostname,
    private readonly pinnedRequest: PinnedRequest = requestWithPinnedDns
  ) {}

  async fetch(
    input: Parameters<NzbFetcherPort["fetch"]>[0]
  ): Promise<Uint8Array> {
    const configured = new URL(input.indexer.baseUrl);
    const approvedRedirectOrigin = this.getApprovedRedirectOrigin(
      input.candidate.guid
    );
    let target = new URL(input.candidate.downloadPath, configured);
    let externalOrigin: string | null = null;
    if (target.origin !== configured.origin) {
      throw new AppError("UNAVAILABLE", 502, "NZB URL left the configured indexer");
    }

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let lease: ResponseLease;
      if (externalOrigin) {
        const addresses = await this.assertPublicRedirectTarget(
          target,
          externalOrigin
        );
        lease = await this.pinnedRequest(target, this.requestInit(input), addresses);
      } else {
        target.searchParams.set("apikey", input.indexer.apiKey);
        lease = {
          response: await this.request(target, this.requestInit(input)),
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
              "Indexer returned an invalid redirect"
            );
          }
          const redirected = new URL(location, target);
          if (redirected.username || redirected.password || redirected.hash) {
            throw new AppError("UNAVAILABLE", 502, "Indexer returned an unsafe redirect");
          }
          if (externalOrigin && redirected.origin !== externalOrigin) {
            throw new AppError(
              "UNAVAILABLE",
              502,
              "Indexer redirected the NZB to another origin"
            );
          }
          if (
            !externalOrigin &&
            redirected.origin !== configured.origin &&
            redirected.origin !== approvedRedirectOrigin
          ) {
            throw new AppError(
              "UNAVAILABLE",
              502,
              "Indexer redirected the NZB to another origin"
            );
          }
          if (redirected.origin !== configured.origin) {
            this.removeIndexerCredentials(redirected, input.indexer.apiKey);
            externalOrigin = redirected.origin;
          }
          target = redirected;
          continue;
        }
        if (!response.ok || !response.body) {
          throw new AppError("UNAVAILABLE", 502, "Indexer NZB retrieval failed");
        }
        return await readBoundedResponse(
          response,
          input.maxBytes,
          () => new AppError(
            "UNAVAILABLE",
            502,
            "Indexer NZB exceeded the size limit"
          )
        );
      } finally {
        if (response.body && !response.bodyUsed) {
          await response.body.cancel().catch(() => undefined);
        }
        await lease.release();
      }
    }
    throw new AppError("UNAVAILABLE", 502, "Indexer redirect limit exceeded");
  }

  private requestInit(
    input: Parameters<NzbFetcherPort["fetch"]>[0]
  ): RequestInit {
    return {
      headers: {
        accept: "application/x-nzb, application/xml, text/xml"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(input.indexer.timeoutMs, 10_000))
    };
  }

  private getApprovedRedirectOrigin(guid: string): string | null {
    try {
      const target = new URL(guid);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.hash
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
      target.protocol !== "https:" ||
      target.origin !== approvedOrigin ||
      target.username ||
      target.password ||
      target.hash
    ) {
      throw new AppError("UNAVAILABLE", 502, "Indexer returned an unsafe redirect");
    }

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.resolve(target.hostname.replace(/^\[|\]$/g, ""));
    } catch {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Indexer redirect host could not be resolved"
      );
    }
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) =>
        !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast"
      )
    ) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Indexer redirected the NZB to a non-public address"
      );
    }
    return addresses;
  }

  private removeIndexerCredentials(target: URL, apiKey: string): void {
    let decodedPath = target.pathname;
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
      throw new AppError("UNAVAILABLE", 502, "Indexer returned an unsafe redirect");
    }
    if (
      decodedPath.includes(apiKey) ||
      [...target.searchParams.values()].some((value) => value.includes(apiKey))
    ) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Indexer redirect exposed the configured API credential"
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
