import { getDatabase } from "@/db/client";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SetupScreen } from "@/features/settings/setup-screen";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  const database = getDatabase();
  const settings = new SqliteSettingsRepository(database);
  const igdb = settings.getIgdb();
  const sabnzbd = settings.getSabnzbd();
  const prowlarr = settings.getProwlarr();
  const platforms = new SqliteCatalogRepository(database).listPlatforms();
  return <SetupScreen readiness={{
    igdbReady: Boolean(
      igdb?.clientId && igdb.clientSecret && igdb.lastTestStatus === "ok"
    ),
    platformsReady: platforms.some((platform) => platform.visible),
    indexerReady: Boolean(
      prowlarr?.baseUrl && prowlarr.apiKey && prowlarr.lastTestStatus === "ok"
    ),
    sabnzbdReady: Boolean(
      sabnzbd?.baseUrl &&
      sabnzbd.apiKey &&
      sabnzbd.lastTestStatus === "ok"
    )
  }} />;
}
