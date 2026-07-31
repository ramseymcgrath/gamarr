import { catalogService } from "@/app/api/catalog/dependencies";
import { handleCatalogSearch } from "@/app/api/catalog/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleCatalogSearch(request, { service: catalogService() });
}
