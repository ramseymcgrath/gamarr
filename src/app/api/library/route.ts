import { libraryDependencies } from "@/app/api/library/dependencies";
import { handleListLibrary } from "@/app/api/library/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleListLibrary(libraryDependencies());
}
