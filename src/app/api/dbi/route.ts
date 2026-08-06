import { dbiDependencies } from "@/app/api/dbi/dependencies";
import { handleDbiIndex } from "@/app/api/dbi/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleDbiIndex(dbiDependencies());
}
