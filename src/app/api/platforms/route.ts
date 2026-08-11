import { catalogService } from "@/app/api/catalog/dependencies";
import { platformListResponse } from "@/app/api/catalog/handlers";
import { platformDependencies } from "@/app/api/platforms/dependencies";
import { handleSetPlatform } from "@/app/api/platforms/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return platformListResponse(catalogService().listPlatforms());
}

export function PUT(request: Request): Promise<Response> {
  return handleSetPlatform(request, platformDependencies());
}
