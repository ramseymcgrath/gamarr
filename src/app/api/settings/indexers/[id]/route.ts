import { settingsDependencies } from "@/app/api/settings/dependencies";
import {
  handleDeleteIndexer,
  handlePutIndexer
} from "@/app/api/settings/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PUT(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const { id } = await context.params;
  return handlePutIndexer(id, request, settingsDependencies());
}

export async function DELETE(
  request: Request,
  context: RouteContext
): Promise<Response> {
  const { id } = await context.params;
  return handleDeleteIndexer(id, request, settingsDependencies());
}
