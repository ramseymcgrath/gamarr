import { settingsDependencies } from "@/app/api/settings/dependencies";
import {
  handleGetSettings,
  handlePostIndexer
} from "@/app/api/settings/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const response = await handleGetSettings(settingsDependencies());
  const settings = await response.json();
  return Response.json(settings.indexers, {
    headers: { "cache-control": "no-store" }
  });
}

export function POST(request: Request): Promise<Response> {
  return handlePostIndexer(request, settingsDependencies());
}
