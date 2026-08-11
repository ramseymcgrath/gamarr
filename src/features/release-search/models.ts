export type QueryReason =
  | "canonical"
  | "canonical-platform"
  | "alternate-platform";

export interface PlannedQuery {
  term: string;
  categories: string[];
  reason: QueryReason;
}

export interface Release {
  guid: string;
  title: string;
  protocol: "usenet" | "torrent";
  indexerId: string;
  indexerName: string;
  downloadUrl: string;
  magnetUrl: string | null;
  seeders: number | null;
  peers: number | null;
  size: number | null;
  category: string | null;
  /** `null` when the source published no usable date — never a 0 sentinel. */
  publishedAt: number | null;
}

export type MatchClass = "Strong" | "Possible" | "Conflicting";

export interface RankedRelease extends Release {
  match: MatchClass;
  score: number;
  supportingReasons: string[];
  conflictingReasons: string[];
  sources: Release[];
}
