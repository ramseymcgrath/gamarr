import { catalogService } from "@/app/api/catalog/dependencies";
import { handleCatalogPopular } from "@/app/api/catalog/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleCatalogPopular(request, { service: catalogService() });
}
