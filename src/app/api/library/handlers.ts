import type { LibraryService } from "@/features/library/service";
import { AppError, validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

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

export async function handleListLibrary(
  dependencies: { service: Pick<LibraryService, "list"> }
): Promise<Response> {
  return Response.json(dependencies.service.list(), {
    headers: { "cache-control": "no-store" }
  });
}

export async function handleGetLibraryEntry(
  id: string,
  dependencies: { service: Pick<LibraryService, "get"> }
): Promise<Response> {
  try {
    return Response.json(dependencies.service.get(id), {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleDeleteLibraryEntry(
  id: string,
  request: Request,
  dependencies: {
    service: Pick<LibraryService, "delete">;
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as { confirmation?: unknown };
    if (typeof body.confirmation !== "string") {
      throw validationError("A title confirmation is required");
    }
    dependencies.service.delete(id, body.confirmation);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
