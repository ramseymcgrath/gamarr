import { catalogService } from "@/app/api/catalog/dependencies";
import { handleSyncPlatforms } from "@/app/api/catalog/handlers";
import { settingsDependencies } from "@/app/api/settings/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSyncPlatforms(request, {
    service: catalogService(),
    policy: settingsDependencies().policy
  });
}
