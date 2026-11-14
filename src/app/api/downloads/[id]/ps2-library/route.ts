import { downloadDependencies } from "@/app/api/downloads/dependencies";
import { handleExportDownload } from "@/app/api/downloads/handlers";
import { verificationService } from "@/app/api/verification/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Queues (or retries) copying a verified PS2 download into the OPL share. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  return handleExportDownload(request, id, {
    service: verificationService(),
    policy: downloadDependencies().policy
  });
}
