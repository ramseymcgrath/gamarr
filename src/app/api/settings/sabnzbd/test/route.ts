import { settingsDependencies } from "@/app/api/settings/dependencies";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SabnzbdClient } from "@/integrations/sabnzbd/client";
import { AppError, validationError } from "@/lib/errors";
import { assertTrustedMutation } from "@/lib/trusted-mutation";
import { getDatabase } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const repository = new SqliteSettingsRepository(getDatabase());
  let trusted = false;
  try {
    assertTrustedMutation(request, settingsDependencies().policy);
    trusted = true;
    const settings = repository.getSabnzbd();
    if (!settings?.apiKey) {
      throw validationError("SABnzbd is not configured");
    }
    await new SabnzbdClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      maxNzbBytes: settings.maxNzbBytes
    }).testConnection();
    repository.recordSabnzbdTest("ok", Date.now());
    return Response.json({ status: "ok" });
  } catch (error) {
    if (trusted) repository.recordSabnzbdTest("failed", Date.now());
    if (error instanceof AppError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    return Response.json(
      { error: { code: "UNAVAILABLE", message: "SABnzbd connection failed" } },
      { status: 502 }
    );
  }
}
