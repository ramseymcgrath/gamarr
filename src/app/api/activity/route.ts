import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { toPublicAttempt } from "@/app/api/downloads/handlers";
import { verificationRepository } from "@/app/api/verification/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const verifications = new Map(
    verificationRepository().list().map((entry) => [entry.attemptId, entry])
  );
  return Response.json(
    downloadDependencies().repository.list().map((attempt) =>
      toPublicAttempt(attempt, verifications.get(attempt.id))),
    { headers: { "cache-control": "no-store" } }
  );
}
