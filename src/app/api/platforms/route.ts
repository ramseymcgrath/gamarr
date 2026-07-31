import { catalogService } from "@/app/api/catalog/dependencies";
import {
  handleSetPlatform,
  platformListResponse
} from "@/app/api/catalog/handlers";
import { settingsDependencies } from "@/app/api/settings/dependencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return platformListResponse(catalogService().listPlatforms());
}

export function PUT(request: Request): Promise<Response> {
  return handleSetPlatform(request, {
    service: catalogService(),
    policy: settingsDependencies().policy
  });
}
