import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { handleReconcileDownloads } from "@/app/api/downloads/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let inFlight: Promise<Response> | null = null;

export function POST(request: Request): Promise<Response> {
  if (inFlight) return inFlight;
  inFlight = handleReconcileDownloads(request, downloadDependencies())
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
