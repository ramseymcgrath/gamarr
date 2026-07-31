import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { toPublicAttempt } from "@/app/api/downloads/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    downloadDependencies().repository.list().map(toPublicAttempt),
    { headers: { "cache-control": "no-store" } }
  );
}
