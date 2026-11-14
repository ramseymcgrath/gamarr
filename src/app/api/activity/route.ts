import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { toPublicAttempt } from "@/app/api/downloads/handlers";
import {
  verificationRepository,
  verificationService
} from "@/app/api/verification/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  const service = verificationService();
  const verifications = new Map(
    verificationRepository().list().map((entry) => [entry.attemptId, entry])
  );
  return Response.json(
    downloadDependencies().repository.list().map((attempt) => {
      const verification = verifications.get(attempt.id);
      return toPublicAttempt(
        attempt,
        verification,
        verification?.status === "Verified" && service.canExport(attempt.id)
      );
    }),
    { headers: { "cache-control": "no-store" } }
  );
}
