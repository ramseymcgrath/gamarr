import { errorResponse } from "@/app/api/error-response";
import { validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

interface PlatformCatalogService {
  setPlatformVisibility(id: number, visible: boolean, aliases: string[]): void;
}

interface PlatformSettingsRepository {
  savePlatformCategories(platformId: number, categoryIds: string[]): void;
}

export async function handleSetPlatform(
  request: Request,
  dependencies: {
    catalog: PlatformCatalogService;
    settings: PlatformSettingsRepository;
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as {
      id?: unknown;
      visible?: unknown;
      aliases?: unknown;
      categoryIds?: unknown;
    };
    if (
      !Number.isInteger(body.id)
      || typeof body.visible !== "boolean"
      || !Array.isArray(body.aliases)
      || !body.aliases.every((alias) => typeof alias === "string")
    ) {
      throw validationError("Invalid platform settings");
    }
    // Optional, and absence is not the same as an empty list. The visibility
    // checkbox sends only id/visible/aliases; requiring the field 400s every
    // toggle, and coercing it to [] would silently wipe a platform's
    // categories as a side effect of showing or hiding it. A malformed value
    // is still rejected.
    if (
      body.categoryIds !== undefined
      && (
        !Array.isArray(body.categoryIds)
        || !body.categoryIds.every((categoryId) => typeof categoryId === "string")
      )
    ) {
      throw validationError("Invalid platform settings");
    }

    const platformId = body.id as number;
    dependencies.catalog.setPlatformVisibility(
      platformId,
      body.visible,
      body.aliases
    );
    if (body.categoryIds !== undefined) {
      dependencies.settings.savePlatformCategories(
        platformId,
        body.categoryIds as string[]
      );
    }
    return Response.json({ status: "ok" });
  } catch (error) {
    return errorResponse(error);
  }
}
