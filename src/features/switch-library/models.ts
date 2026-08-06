/** One installable file found on disk by a scan. */
export interface SwitchLibraryFile {
  /** Fully resolved, symlinks followed, confirmed inside its root. */
  absolutePath: string;
  fileName: string;
  /**
   * Basename of the containing directory. Where this is `gamarr-{attemptId}`
   * it matches `download_attempts.sab_marker` exactly and yields a real game
   * title.
   */
  parentDirName: string;
  sizeBytes: number;
  sourceRoot: string;
}

/**
 * One row of the rendered index. `name` is both the link text and the URL
 * segment — DBI derives the filename it installs under from the URL basename,
 * so the two cannot diverge.
 */
export interface SwitchLibraryEntry {
  name: string;
  absolutePath: string;
  sizeBytes: number;
}
