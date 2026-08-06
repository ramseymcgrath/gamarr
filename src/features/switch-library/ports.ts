import type { SwitchLibraryFile } from "@/features/switch-library/models";

export interface SwitchLibraryScanner {
  scan(roots: string[]): Promise<SwitchLibraryFile[]>;
}

export interface SwitchLibraryTitleReader {
  /** Maps `sab_marker` -> game title. Absent markers are simply omitted. */
  titlesByMarker(markers: string[]): Map<string, string>;
}

/**
 * An open file descriptor plus its size, read under one handle.
 *
 * Ownership rule: once `stream()` is called the returned stream owns the
 * handle and closes it on end or destroy. Call `close()` only on paths that
 * never stream — a 416, or an error before streaming begins — or the handle
 * is closed twice.
 */
export interface OpenedFile {
  sizeBytes: number;
  stream(start: number, end: number): ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface FileOpener {
  /** Resolves null when the path is missing, unreadable, or not a regular file. */
  open(absolutePath: string): Promise<OpenedFile | null>;
}
