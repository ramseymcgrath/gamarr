import type {
  DiscSerials,
  SerialCatalogPort
} from "@/features/release-search/ports";
import { REDUMP_SYSTEMS } from "@/features/verification/models";
import type { RedumpSourcePort } from "@/features/verification/ports";
import {
  normalizeSerial,
  serialsForTitles
} from "@/features/verification/redump";

/** Release search's view of the Redump lists verification already caches. */
export class RedumpSerialCatalog implements SerialCatalogPort {
  constructor(private readonly source: RedumpSourcePort) {}

  async lookup(platformId: number, titles: string[]): Promise<DiscSerials | null> {
    const system = REDUMP_SYSTEMS.get(platformId);
    if (!system) return null;
    const index = await this.source.load(system.datName);
    return {
      serials: serialsForTitles(index, titles),
      gameFor: (serial) =>
        index.bySerial.get(normalizeSerial(serial))?.[0]?.gameName ?? null
    };
  }
}
