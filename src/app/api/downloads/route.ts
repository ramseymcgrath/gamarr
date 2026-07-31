import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { handleSubmitDownload } from "@/app/api/downloads/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSubmitDownload(request, downloadDependencies());
}
