import type { SwitchLibraryEntry } from "@/features/switch-library/models";
import type {
  SwitchLibraryScanner,
  SwitchLibraryTitleReader
} from "@/features/switch-library/ports";
import {
  extensionOf,
  markerFromDirName,
  resolveDisplayNames
} from "@/features/switch-library/slug-policy";

/**
 * Composes a scan of the configured roots with the titles gamarr knows,
 * producing the list DBI browses.
 *
 * There is no cache: both entry points rescan. A cached entry can outlive the
 * file it names, so the read path would need to revalidate on open anyway —
 * which is most of the scan cost back, plus an invalidation story, for a
 * directory holding tens of files. Rescanning is self-healing instead.
 */
export class SwitchLibraryService {
  constructor(
    private readonly scanner: SwitchLibraryScanner,
    private readonly titles: SwitchLibraryTitleReader,
    private readonly roots: string[]
  ) {}

  isEnabled(): boolean {
    return this.roots.length > 0;
  }

  async index(): Promise<SwitchLibraryEntry[]> {
    if (!this.isEnabled()) return [];

    const files = await this.scanner.scan(this.roots);
    const markers = [
      ...new Set(
        files
          .map((file) => markerFromDirName(file.parentDirName))
          .filter((marker): marker is string => marker !== null)
      )
    ];
    const titles = this.titles.titlesByMarker(markers);

    const candidates = files.map((file) => {
      const marker = markerFromDirName(file.parentDirName);
      const title = marker === null ? undefined : titles.get(marker);
      return {
        absolutePath: file.absolutePath,
        preferredName:
          title === undefined ? file.fileName : `${title}${extensionOf(file.fileName)}`,
        sizeBytes: file.sizeBytes
      };
    });

    const names = resolveDisplayNames(candidates);

    return candidates
      .map((candidate) => ({
        name: names.get(candidate.absolutePath) ?? candidate.preferredName,
        absolutePath: candidate.absolutePath,
        sizeBytes: candidate.sizeBytes
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name: string): Promise<SwitchLibraryEntry | null> {
    const entries = await this.index();
    return entries.find((entry) => entry.name === name) ?? null;
  }
}
