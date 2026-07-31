import { settingsDependencies } from "@/app/api/settings/dependencies";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SabnzbdClient } from "@/integrations/sabnzbd/client";
import { AppError, validationError } from "@/lib/errors";
import { assertTrustedMutation } from "@/lib/trusted-mutation";
import { getDatabase } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedMutation(request, settingsDependencies().policy);
    const settings = new SqliteSettingsRepository(getDatabase()).getSabnzbd();
    if (!settings?.apiKey) {
      throw validationError("SABnzbd is not configured");
    }
    await new SabnzbdClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      maxNzbBytes: settings.maxNzbBytes
    }).testConnection();
    return Response.json({ status: "ok" });
  } catch (error) {
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
