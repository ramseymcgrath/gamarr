import createIgdbClient from "igdb-api-node";
import { z } from "zod";

import type {
  GameSearchResult,
  Platform
} from "@/features/catalog/models";
import type { IgdbPort } from "@/features/catalog/ports";
import { AppError } from "@/lib/errors";
import type { TokenPort } from "@/integrations/igdb/token-manager";

export interface IgdbRequest {
  endpoint: "/platforms" | "/games";
  fields: string[];
  search?: string;
  where?: string;
  limit: number;
  offset: number;
}

export interface IgdbExecutor {
  execute(accessToken: string, request: IgdbRequest): Promise<unknown>;
}

export interface IgdbClientOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  gate?: () => Promise<void>;
}

interface SdkExecutorOptions {
  clientId: string;
  baseUrl?: string;
}

export class SdkIgdbExecutor implements IgdbExecutor {
  constructor(private readonly options: SdkExecutorOptions) {}

  async execute(accessToken: string, request: IgdbRequest): Promise<unknown> {
    let query = createIgdbClient(this.options.clientId, accessToken, {
      baseURL: this.options.baseUrl ?? "https://api.igdb.com/v4"
    })
      .fields(request.fields)
      .limit(request.limit)
      .offset(request.offset);
    if (request.search) query = query.search(request.search);
    if (request.where) query = query.where(request.where);
    try {
      const response = await query.request(request.endpoint);
      return response.data;
    } catch (error) {
      const status = (
        error as { response?: { status?: number }; status?: number }
      ).response?.status ?? (error as { status?: number }).status;
      throw Object.assign(
        new AppError(
          "UNAVAILABLE",
          status === 401 ? 401 : 502,
          "IGDB request failed",
          { cause: error }
        ),
        { status }
      );
    }
  }
}

const platformSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  abbreviation: z.string().optional(),
  generation: z.number().int().optional(),
  checksum: z.string().optional()
});

const gameSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().optional(),
  platforms: z.array(z.number().int().positive()).default([]),
  genres: z.array(z.object({ name: z.string() })).default([]),
  alternative_names: z.array(z.object({ name: z.string() })).default([]),
  release_dates: z.array(z.object({
    platform: z.number().int().positive(),
    y: z.number().int().optional()
  })).default([]),
  cover: z.object({ image_id: z.string() }).optional()
});

export class IgdbClient implements IgdbPort {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly gate: () => Promise<void>;

  constructor(
    private readonly tokens: TokenPort,
    private readonly executor: IgdbExecutor,
    options: IgdbClientOptions = {}
  ) {
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.gate = options.gate ?? (async () => undefined);
  }

  async testConnection(): Promise<void> {
    await this.execute({
      endpoint: "/platforms",
      fields: ["id"],
      limit: 1,
      offset: 0
    });
  }

  async listPlatforms(): Promise<Platform[]> {
    const output: Platform[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = z.array(platformSchema).parse(await this.execute({
        endpoint: "/platforms",
        fields: ["id", "name", "abbreviation", "generation", "checksum"],
        limit: 500,
        offset
      }));
      output.push(...page);
      if (page.length < 500) break;
    }
    return output;
  }

  async searchGames(
    query: string,
    platformId: number
  ): Promise<GameSearchResult[]> {
    const games = z.array(gameSchema).parse(await this.execute({
      endpoint: "/games",
      fields: [
        "id",
        "name",
        "slug",
        "summary",
        "platforms",
        "genres.name",
        "alternative_names.name",
        "release_dates.platform",
        "release_dates.y",
        "cover.image_id"
      ],
      search: query,
      where: `platforms = {${platformId}}`,
      limit: 24,
      offset: 0
    }));

    return games.map((game) => ({
      id: game.id,
      name: game.name,
      slug: game.slug,
      summary: game.summary ?? null,
      coverUrl: game.cover
        ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
        : null,
      releaseYear: game.release_dates
        .find((date) => date.platform === platformId && date.y)?.y ?? null,
      genres: game.genres.map((genre) => genre.name),
      alternativeNames: game.alternative_names.map((name) => name.name),
      platformIds: game.platforms
    }));
  }

  private async execute(request: IgdbRequest): Promise<unknown> {
    let token = await this.tokens.getAccessToken();
    let authenticationRetried = false;
    let rateLimitRetries = 0;

    for (;;) {
      await this.gate();
      try {
        return await this.executor.execute(token, request);
      } catch (error) {
        const typed = error as { status?: number; retryAfterMs?: number };
        if (typed.status === 401 && !authenticationRetried) {
          authenticationRetried = true;
          this.tokens.invalidate();
          token = await this.tokens.getAccessToken();
          continue;
        }
        if (typed.status === 429 && rateLimitRetries < 2) {
          rateLimitRetries += 1;
          await this.sleep(typed.retryAfterMs ?? 250 * rateLimitRetries);
          continue;
        }
        throw error;
      }
    }
  }
}
