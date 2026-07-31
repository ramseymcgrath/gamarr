import { releaseSearchDependencies } from "@/app/api/releases/dependencies";
import { handleReleaseSearch } from "@/app/api/releases/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleReleaseSearch(request, releaseSearchDependencies());
}
