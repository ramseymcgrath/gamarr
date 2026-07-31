import { libraryDependencies } from "@/app/api/library/dependencies";
import {
  handleDeleteLibraryEntry,
  handleGetLibraryEntry
} from "@/app/api/library/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext
): Promise<Response> {
  return handleGetLibraryEntry((await context.params).id, libraryDependencies());
}

export async function DELETE(
  request: Request,
  context: RouteContext
): Promise<Response> {
  return handleDeleteLibraryEntry(
    (await context.params).id,
    request,
    libraryDependencies()
  );
}
