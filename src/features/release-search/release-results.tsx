"use client";

import {
  ArrowDownUp,
  Check,
  Download,
  HardDrive,
  TriangleAlert
} from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import type {
  PublicRelease,
  PublicReleaseSource
} from "@/features/release-search/service";
import { DownloadDialog } from "@/features/release-search/download-dialog";

function formatBytes(value: number | null): string {
  if (value === null) return "SIZE UNKNOWN";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function formatPublishedAt(value: number | null): string {
  return value === null
    ? "DATE UNKNOWN"
    : new Date(value).toLocaleDateString();
}

/**
 * MIN_SAFE_INTEGER, not -Infinity: `-Infinity - -Infinity` is NaN, which makes
 * the comparator non-transitive as soon as two undated releases meet. Undated
 * releases still sort last under "newest", exactly as before.
 */
function publishedOrder(release: PublicRelease): number {
  return release.publishedAt ?? Number.MIN_SAFE_INTEGER;
}

export function ReleaseResults({
  gameId,
  platformId,
  releases,
  usenetClientConfigured,
  torrentClientConfigured,
  warnings = []
}: {
  gameId: number;
  platformId: number;
  releases: PublicRelease[];
  usenetClientConfigured: boolean;
  torrentClientConfigured: boolean;
  warnings?: Array<{ indexerName: string; message: string }>;
}) {
  const [sort, setSort] = useState<"best" | "newest" | "smallest">("best");
  const [selection, setSelection] = useState<{
    candidateId: string;
    title: string;
    indexerName: string;
    protocol: PublicReleaseSource["protocol"];
    clientConfigured: boolean;
  } | null>(null);
  const sorted = useMemo(() => [...releases].sort((left, right) => {
    if (sort === "newest") return publishedOrder(right) - publishedOrder(left);
    if (sort === "smallest") {
      return (left.size ?? Number.MAX_SAFE_INTEGER) -
        (right.size ?? Number.MAX_SAFE_INTEGER);
    }
    return right.score - left.score ||
      publishedOrder(right) - publishedOrder(left) ||
      left.title.localeCompare(right.title);
  }), [releases, sort]);

  return (
    <section className="release-section" aria-labelledby="release-heading">
      <div className="result-heading">
        <div>
          <p className="eyebrow">INDEXER RESULTS</p>
          <h2 id="release-heading">{releases.length} releases found</h2>
        </div>
        <label className="sort-control">
          <ArrowDownUp aria-hidden="true" />
          <span className="sr-only">Sort releases</span>
          <select
            aria-label="Sort releases"
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="best">Best match</option>
            <option value="newest">Newest</option>
            <option value="smallest">Smallest</option>
          </select>
        </label>
      </div>
      {warnings.length > 0 && (
        <div className="warning-banner">
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>Partial search results</strong>
            {warnings.map((warning, index) => (
              <span key={`${warning.indexerName}-${index}`}>
                {warning.indexerName}: {warning.message}
              </span>
            ))}
          </div>
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyState title="No releases found">
          Try a shorter title, review platform aliases, or check indexer
          categories in Settings.
        </EmptyState>
      ) : (
        <div className="release-list">
          {sorted.map((release) => (
            // Deduplication groups by normalized title *and* size, so title
            // plus publishedAt is not unique. Candidate IDs are minted once per
            // source after deduplication and survive re-sorts.
            <article className="release-row" key={release.sources[0]?.candidateId}>
              <div className="release-main">
                <div className="release-title-row">
                  <StatusPill status={release.match} label={release.match} />
                  <h3>{release.title}</h3>
                </div>
                <div className="release-meta mono">
                  <span><HardDrive aria-hidden="true" /> {formatBytes(release.size)}</span>
                  <span>{release.category ?? "UNCATEGORIZED"}</span>
                  <span>{formatPublishedAt(release.publishedAt)}</span>
                </div>
                <div className="evidence">
                  {release.supportingReasons.map((reason) => (
                    <span className="evidence-good" key={reason}>
                      <Check aria-hidden="true" /> {reason}
                    </span>
                  ))}
                  {release.conflictingReasons.map((reason) => (
                    <span className="evidence-bad" key={reason}>
                      <TriangleAlert aria-hidden="true" /> {reason}
                    </span>
                  ))}
                </div>
              </div>
              <div className="source-actions">
                {release.sources.map((source) => (
                  <Button
                    key={source.candidateId}
                    aria-label={`${source.indexerName} ${source.protocol}`}
                    onClick={() => setSelection({
                      candidateId: source.candidateId,
                      title: release.title,
                      indexerName: source.indexerName,
                      protocol: source.protocol,
                      clientConfigured: source.protocol === "torrent"
                        ? torrentClientConfigured
                        : usenetClientConfigured
                    })}
                  >
                    {source.protocol === "torrent"
                      ? <Download aria-hidden="true" />
                      : <HardDrive aria-hidden="true" />}
                    <span>{source.protocol === "torrent" ? "Torrent" : "Usenet"}</span>
                    {source.protocol === "torrent" && (
                      <small>{source.seeders === null
                        ? "Seeder count unknown"
                        : `${source.seeders} seeders`}</small>
                    )}
                    <small>{source.indexerName}</small>
                  </Button>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      {selection && (
        <DownloadDialog
          open
          onOpenChange={(open) => !open && setSelection(null)}
          gameId={gameId}
          platformId={platformId}
          {...selection}
        />
      )}
    </section>
  );
}
