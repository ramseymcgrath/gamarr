import { errorResponse } from "@/app/api/error-response";
import type { SettingsService } from "@/features/settings/service";
import type { IndexerInput } from "@/features/settings/models";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

interface ReadDependencies {
  service: SettingsService;
}

interface MutationDependencies extends ReadDependencies {
  policy: OriginPolicy;
}

export async function handleGetSettings(
  dependencies: ReadDependencies
): Promise<Response> {
  return Response.json(dependencies.service.getRedacted(), {
    headers: { "cache-control": "no-store" }
  });
}

export async function handlePutIgdb(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveIgdb(await request.json());
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutSabnzbd(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveSabnzbd(await request.json());
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutQbittorrent(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.saveQbittorrent(await request.json());
    return Response.json(dependencies.service.getRedacted());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePostIndexer(
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    return Response.json(
      dependencies.service.saveIndexer(await request.json()),
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handlePutIndexer(
  id: string,
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as Omit<IndexerInput, "id">;
    return Response.json(dependencies.service.saveIndexer({ ...body, id }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleDeleteIndexer(
  id: string,
  request: Request,
  dependencies: MutationDependencies
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    dependencies.service.deleteIndexer(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
