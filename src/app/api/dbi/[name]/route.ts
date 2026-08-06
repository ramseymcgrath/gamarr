import { dbiDependencies } from "@/app/api/dbi/dependencies";
import { handleDbiFile } from "@/app/api/dbi/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ name: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const { name } = await context.params;
  // Next.js leaves the segment percent-encoded; the index emits
  // encodeURIComponent(name), so decoding here round-trips it.
  return handleDbiFile(decodeURIComponent(name), request, dbiDependencies());
}
