import { handleGetSettings } from "@/app/api/settings/handlers";
import { settingsDependencies } from "@/app/api/settings/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleGetSettings(settingsDependencies());
}
