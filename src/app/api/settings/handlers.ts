import type { SettingsService } from "@/features/settings/service";
import { AppError } from "@/lib/errors";
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
