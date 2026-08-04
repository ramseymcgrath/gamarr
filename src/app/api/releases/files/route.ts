import { releaseSearchDependencies } from "@/app/api/releases/dependencies";
import { handleListCandidateFiles } from "@/app/api/releases/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleListCandidateFiles(request, releaseSearchDependencies());
}
