import type {
  CatalogSearchInput,
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import { AppError, validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

export interface CatalogHandlerService {
  search(input: CatalogSearchInput): Promise<unknown>;
  getGame(id: number): unknown;
  syncPlatforms(): Promise<unknown>;
}

function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status }
    );
  }
  return Response.json(
    { error: { code: "INTERNAL", message: "Unexpected server error" } },
    { status: 500 }
  );
}

export async function handleCatalogSearch(
  request: Request,
  dependencies: { service: CatalogHandlerService }
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const platformId = Number(url.searchParams.get("platformId"));
    if (!Number.isInteger(platformId) || platformId <= 0) {
      throw validationError("platformId must be a positive integer");
    }
    const query = url.searchParams.get("query") ?? "";
    return Response.json(
      await dependencies.service.search({ query, platformId }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleGetGame(
  id: number,
  dependencies: { service: CatalogHandlerService }
): Promise<Response> {
  const game = dependencies.service.getGame(id);
  if (!game) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Game not found" } },
      { status: 404 }
    );
  }
  return Response.json(game, { headers: { "cache-control": "no-store" } });
}

export async function handleSyncPlatforms(
  request: Request,
  dependencies: {
    service: CatalogHandlerService;
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    return Response.json(await dependencies.service.syncPlatforms());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleSetPlatform(
  request: Request,
  dependencies: {
    service: CatalogHandlerService & {
      setPlatformVisibility(id: number, visible: boolean, aliases: string[]): void;
    };
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as {
      id?: unknown;
      visible?: unknown;
      aliases?: unknown;
    };
    if (
      !Number.isInteger(body.id) ||
      typeof body.visible !== "boolean" ||
      !Array.isArray(body.aliases) ||
      !body.aliases.every((alias) => typeof alias === "string")
    ) {
      throw validationError("Invalid platform settings");
    }
    dependencies.service.setPlatformVisibility(
      body.id as number,
      body.visible,
      body.aliases
    );
    return Response.json({ status: "ok" });
  } catch (error) {
    return errorResponse(error);
  }
}

export function platformListResponse(platforms: PlatformView[]): Response {
  return Response.json(platforms, {
    headers: { "cache-control": "no-store" }
  });
}

export function gameListResponse(games: GameSearchResult[]): Response {
  return Response.json(games, {
    headers: { "cache-control": "no-store" }
  });
}
