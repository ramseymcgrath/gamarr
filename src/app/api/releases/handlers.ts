import { errorResponse } from "@/app/api/error-response";
import type {
  CandidateFilesResponse,
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

interface CandidateFilesHandlerService {
  listCandidateFiles(candidateId: string): Promise<CandidateFilesResponse>;
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

/**
 * Lists the files declared by torrent metainfo bound to a live release
 * candidate. Read-only, so there is no mutation guard: the
 * opaque candidate ID means the request cannot be aimed at anything the
 * server did not already mint. Which files are selectable is release-search
 * domain policy and lives in the feature slice, not here.
 */
export async function handleListCandidateFiles(
  request: Request,
  dependencies: { service: CandidateFilesHandlerService }
): Promise<Response> {
  try {
    const candidateId = new URL(request.url).searchParams.get("candidateId");
    if (!candidateId) throw validationError("candidateId is required");
    const response = await dependencies.service.listCandidateFiles(candidateId);
    return Response.json(response, {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return errorResponse(error);
  }
}
