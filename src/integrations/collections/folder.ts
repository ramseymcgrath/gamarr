import fs from "node:fs";
import path from "node:path";

import type {
  Collection,
  CollectionsPort
} from "@/features/release-search/ports";
import {
  decodeTorrentFiles,
  torrentInfoHash,
  torrentRoot
} from "@/integrations/prowlarr/metainfo";

type Parsed =
  | { ok: true; collection: Collection }
  | { ok: false; reason: string };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: Parsed;
}

/**
 * Collections are multi-file `.torrent` files an operator drops into
 * `<dir>/<platformId>/`. Only regular files are read; anything else is skipped
 * with a warning so a bad drop never breaks search.
 */
export class FolderCollections implements CollectionsPort {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly input: { dir: string; maxBytes: number }) {}

  list(platformId: number): { collections: Collection[]; warnings: string[] } {
    const collections: Collection[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    for (const entry of this.readDir(this.input.dir)) {
      if (!/^\d+$/.test(entry)) continue;
      const folder = path.join(this.input.dir, entry);
      if (!this.isDirectory(folder) || Number(entry) !== platformId) continue;
      for (const file of this.readDir(folder).sort()) {
        if (!file.endsWith(".torrent")) continue;
        const parsed = this.parse(path.join(folder, file), file, platformId);
        if (!parsed.ok) {
          warnings.push(`Collection ${file}: ${parsed.reason}`);
          continue;
        }
        if (seen.has(parsed.collection.id)) continue;
        seen.add(parsed.collection.id);
        collections.push(parsed.collection);
      }
    }

    for (const entry of this.readDir(this.input.dir)) {
      if (!entry.endsWith(".torrent")) continue;
      warnings.push(
        `Collection ${entry}: ignored, move it into a platform folder such as ${this.input.dir}/<platformId>/`
      );
    }
    return { collections, warnings };
  }

  read(id: string): { collection: Collection; bytes: Uint8Array } | null {
    for (const entry of this.readDir(this.input.dir)) {
      if (!/^\d+$/.test(entry)) continue;
      const platformId = Number(entry);
      const folder = path.join(this.input.dir, entry);
      if (!this.isDirectory(folder)) continue;
      const match = this.list(platformId).collections.find((c) => c.id === id);
      if (!match) continue;
      const target = path.join(folder, match.torrentFileName);
      try {
        const bytes = new Uint8Array(fs.readFileSync(target));
        if (torrentInfoHash(bytes).hash !== id) return null;
        return { collection: match, bytes };
      } catch {
        return null;
      }
    }
    return null;
  }

  private readDir(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  private isDirectory(target: string): boolean {
    try {
      return fs.lstatSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  private parse(target: string, fileName: string, platformId: number): Parsed {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (!stat.isFile()) return { ok: false, reason: "not a regular file, skipped" };
    if (stat.size > this.input.maxBytes) {
      return { ok: false, reason: `larger than ${this.input.maxBytes} bytes, skipped` };
    }

    const cached = this.cache.get(target);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.result;
    }

    const result = this.load(target, fileName, platformId);
    this.cache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    return result;
  }

  private load(target: string, fileName: string, platformId: number): Parsed {
    try {
      const bytes = new Uint8Array(fs.readFileSync(target));
      const { hash, v2 } = torrentInfoHash(bytes);
      if (v2) return { ok: false, reason: "v2 torrents are not supported, skipped" };
      const decoded = decodeTorrentFiles(bytes);
      const { name: root, multiFile } = torrentRoot(bytes);
      const files = decoded.map((file) => ({
        index: file.index,
        name: multiFile && file.name.startsWith(`${root}/`)
          ? file.name.slice(root.length + 1)
          : file.name,
        size: file.size ?? 0
      }));
      return {
        ok: true,
        collection: {
          id: hash,
          platformId,
          name: root,
          torrentFileName: fileName,
          files
        }
      };
    } catch {
      return { ok: false, reason: "malformed torrent, skipped" };
    }
  }
}
