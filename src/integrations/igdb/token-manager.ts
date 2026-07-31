import { z } from "zod";

import { AppError, validationError } from "@/lib/errors";

export interface TokenPort {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number;
}

interface TokenManagerOptions {
  credentials(): TwitchCredentials;
  requestToken?(credentials: TwitchCredentials): Promise<TokenResponse>;
  now?: () => number;
  tokenEndpoint?: string;
}

const twitchResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive()
});

export class TwitchTokenManager implements TokenPort {
  private token: { value: string; refreshAt: number } | null = null;
  private refreshPromise: Promise<string> | null = null;
  private readonly now: () => number;
  private readonly requestToken: (credentials: TwitchCredentials) => Promise<TokenResponse>;

  constructor(options: TokenManagerOptions) {
    this.now = options.now ?? Date.now;
    this.requestToken = options.requestToken ?? ((credentials) =>
      this.fetchToken(credentials, options.tokenEndpoint ?? "https://id.twitch.tv/oauth2/token"));
    this.credentials = options.credentials;
  }

  private readonly credentials: () => TwitchCredentials;

  async getAccessToken(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAt) {
      return this.token.value;
    }
    this.refreshPromise ??= this.refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  invalidate(): void {
    this.token = null;
  }

  private async refresh(): Promise<string> {
    const credentials = this.credentials();
    if (!credentials.clientId || !credentials.clientSecret) {
      throw validationError("IGDB credentials are not configured");
    }
    const response = await this.requestToken(credentials);
    const refreshInSeconds = Math.max(1, response.expiresInSeconds - 60);
    this.token = {
      value: response.accessToken,
      refreshAt: this.now() + refreshInSeconds * 1000
    };
    return response.accessToken;
  }

  private async fetchToken(
    credentials: TwitchCredentials,
    endpoint: string
  ): Promise<TokenResponse> {
    const url = new URL(endpoint);
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("client_secret", credentials.clientSecret);
    url.searchParams.set("grant_type", "client_credentials");
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new AppError(
        "UNAVAILABLE",
        response.status === 401 ? 401 : 502,
        "Twitch authentication failed"
      );
    }
    const parsed = twitchResponseSchema.parse(await response.json());
    return {
      accessToken: parsed.access_token,
      expiresInSeconds: parsed.expires_in
    };
  }
}
