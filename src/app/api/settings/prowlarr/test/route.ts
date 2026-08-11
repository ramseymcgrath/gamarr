import { prowlarrTestDependencies } from "@/app/api/settings/dependencies";
import { handleTestProwlarr } from "@/app/api/settings/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleTestProwlarr(request, prowlarrTestDependencies());
}
