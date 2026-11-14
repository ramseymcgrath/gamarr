import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { handleVerifyDownload } from "@/app/api/downloads/handlers";
import { verificationService } from "@/app/api/verification/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queues (or re-runs) a Redump check of a completed download. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  return handleVerifyDownload(request, id, {
    service: verificationService(),
    policy: downloadDependencies().policy
  });
}
