import { errorResponse } from "@/app/api/error-response";
import type {
  ReleaseSearchInput,
  ReleaseSearchResponse
} from "@/features/release-search/service";
import { validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

interface ReleaseSearchHandlerService {
  search(input: ReleaseSearchInput): Promise<ReleaseSearchResponse | unknown>;
}

export async function handleReleaseSearch(
  request: Request,
  dependencies: {
    service: ReleaseSearchHandlerService;
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as {
      gameId?: unknown;
      platformId?: unknown;
    };
    if (
      !Number.isInteger(body.gameId) ||
      Number(body.gameId) <= 0 ||
      !Number.isInteger(body.platformId) ||
      Number(body.platformId) <= 0
    ) {
      throw validationError("gameId and platformId must be positive integers");
    }
    const response = await dependencies.service.search({
      gameId: body.gameId as number,
      platformId: body.platformId as number
    });
    return Response.json(response, {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return errorResponse(error);
  }
}
