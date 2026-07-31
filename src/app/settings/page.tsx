import { getDatabase } from "@/db/client";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SettingsScreen } from "@/features/settings/settings-screen";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SettingsService } from "@/features/settings/service";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const database = getDatabase();
  const initial = new SettingsService(
    new SqliteSettingsRepository(database)
  ).getRedacted();
  const platforms = new SqliteCatalogRepository(database).listPlatforms();
  return <SettingsScreen initial={initial} platforms={platforms} />;
}
