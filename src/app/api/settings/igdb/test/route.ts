import { catalogService } from "@/app/api/catalog/dependencies";
import { settingsDependencies } from "@/app/api/settings/dependencies";
import { AppError } from "@/lib/errors";
import { assertTrustedMutation } from "@/lib/trusted-mutation";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { getDatabase } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const repository = new SqliteSettingsRepository(getDatabase());
  let trusted = false;
  try {
    assertTrustedMutation(request, settingsDependencies().policy);
    trusted = true;
    await catalogService().testConnection();
    repository.recordIgdbTest("ok", Date.now());
    return Response.json({ status: "ok" });
  } catch (error) {
    if (trusted) repository.recordIgdbTest("failed", Date.now());
    if (error instanceof AppError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    return Response.json(
      { error: { code: "UNAVAILABLE", message: "IGDB connection failed" } },
      { status: 502 }
    );
  }
}
