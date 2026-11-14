import { spawn } from "node:child_process";

import type { ArchiveEntry, ArchivePort } from "@/features/verification/ports";
import { AppError } from "@/lib/errors";

const LIST_TIMEOUT_MS = 60_000;
const MAX_LIST_BYTES = 8 * 1024 * 1024;

/**
 * `.7z`/`.zip`/`.rar` through the 7-Zip CLI (Debian `7zip` + `7zip-rar`).
 * Nothing is ever written to disk: entries stream out on stdout.
 *
 * Every invocation uses `-spd` (no wildcards: a name is a literal name),
 * `-p…` (an encrypted archive fails instead of prompting) and `--` before the
 * paths, and arguments go to `spawn` as an array, never through a shell.
 */
export class SevenZipArchives implements ArchivePort {
  constructor(private readonly binary = process.env.GAMARR_7Z_PATH || "7z") {}

  async list(archivePath: string): Promise<ArchiveEntry[]> {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.binary,
        ["l", "-slt", "-ba", "-spd", "-pgamarr-no-password", "--", archivePath],
        { stdio: ["ignore", "pipe", "ignore"], timeout: LIST_TIMEOUT_MS }
      );
      let text = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > MAX_LIST_BYTES) child.kill();
      });
      child.on("error", () => reject(unavailable("7-Zip isn't installed in this container")));
      child.on("close", (code) => code === 0
        ? resolve(text)
        : reject(unavailable("The archive is damaged, encrypted or not one gamarr can read")));
    });
    return parseListing(output);
  }

  async *open(archivePath: string, entry: string): AsyncGenerator<Uint8Array> {
    const child = spawn(
      this.binary,
      ["e", "-so", "-spd", "-pgamarr-no-password", "--", archivePath, entry],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
    let finished = false;
    try {
      for await (const chunk of child.stdout) yield chunk as Uint8Array;
      finished = true;
    } finally {
      // A consumer that stops early (head-only read) mustn't leave 7z running.
      if (!finished) child.kill();
    }
    const code = await exited;
    if (code === null) throw unavailable("7-Zip isn't installed in this container");
    // 7z checks the archive's own CRCs while extracting and exits non-zero
    // when one fails, after it has already written the bad bytes.
    if (code !== 0) {
      throw unavailable("The archive is damaged or encrypted (7-Zip's integrity check failed)");
    }
  }
}

function unavailable(message: string): AppError {
  return new AppError("UNAVAILABLE", 502, message);
}

/** `7z l -slt -ba`: blank-line-separated `Key = Value` blocks, one per entry. */
export function parseListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const block of output.split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^([^=]+?) = (.*)$/.exec(line);
      if (match) fields.set(match[1]!, match[2]!);
    }
    const path = fields.get("Path");
    if (!path) continue;
    const isFolder = fields.get("Folder") === "+"
      || (fields.get("Attributes") ?? "").startsWith("D");
    if (isFolder) continue;
    entries.push({ path, size: Number(fields.get("Size") ?? 0) || 0 });
  }
  return entries;
}
