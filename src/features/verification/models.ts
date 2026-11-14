export type VerificationStatus =
  | "Pending"
  | "Running"
  /** Every disc image hashed to a Redump entry. */
  | "Verified"
  /** A disc image is identifiably the wrong thing: a known game whose hash
   * differs from Redump's (modified, patched or bad dump), or a disc for a
   * different system. */
  | "Mismatch"
  /** Not in Redump and nothing contradicts it: can't vouch either way. */
  | "Unknown"
  /** Can't be checked as downloaded: compressed, unmapped folder, platform
   * without a checksum list. */
  | "Unsupported"
  /** The check itself failed (client unreachable, read error). */
  | "Failed";

export interface DownloadVerification {
  attemptId: string;
  status: VerificationStatus;
  /** Checked file name(s), relative to the download folder. */
  fileName: string | null;
  sha1: string | null;
  serial: string | null;
  redumpName: string | null;
  detail: string | null;
  requestedAt: number;
  checkedAt: number | null;
  updatedAt: number;
}

export type VerificationResult = Pick<
  DownloadVerification,
  "status" | "fileName" | "sha1" | "serial" | "redumpName" | "detail"
>;

/**
 * Platforms with a Redump checksum list, keyed by IGDB platform id. `disc` is
 * the `SYSTEM.CNF` boot style the platform's discs carry.
 */
export const REDUMP_SYSTEMS: ReadonlyMap<
  number,
  { datName: string; disc: "ps2" | "ps1"; label: string }
> = new Map([
  [8, { datName: "Sony - PlayStation 2", disc: "ps2", label: "PS2" }],
  [7, { datName: "Sony - PlayStation", disc: "ps1", label: "PS1" }]
]);
