import { settingsDependencies } from "@/app/api/settings/dependencies";
import { handlePutIgdb } from "@/app/api/settings/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request): Promise<Response> {
  return handlePutIgdb(request, settingsDependencies());
}
