import { catalogService } from "@/app/api/catalog/dependencies";
import { handleGetGame } from "@/app/api/catalog/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  return handleGetGame(Number(id), { service: catalogService() });
}
