import { errorResponse } from "@/app/api/error-response";
import { settingsDependencies } from "@/app/api/settings/dependencies";
import { getDatabase } from "@/db/client";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";
import { validationError } from "@/lib/errors";
import { assertTrustedMutation } from "@/lib/trusted-mutation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const repository = new SqliteSettingsRepository(getDatabase());
  let trusted = false;
  try {
    assertTrustedMutation(request, settingsDependencies().policy);
    trusted = true;
    const settings = repository.getQbittorrent();
    if (!settings?.password) {
      throw validationError("qBittorrent is not configured");
    }
    await new QbittorrentClient({
      baseUrl: settings.baseUrl,
      username: settings.username,
      password: settings.password
    }).testConnection();
    repository.recordQbittorrentTest("ok", Date.now());
    return Response.json({ status: "ok" });
  } catch (error) {
    if (trusted) repository.recordQbittorrentTest("failed", Date.now());
    return errorResponse(error, {
      code: "UNAVAILABLE",
      message: "qBittorrent connection failed",
      status: 502
    });
  }
}
