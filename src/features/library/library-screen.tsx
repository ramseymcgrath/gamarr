import {
  Disc3,
  Gamepad2,
  Plus
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";

import { EmptyState } from "@/components/empty-state";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import type { LibraryCard } from "@/features/library/models";

export function LibraryScreen({ entries }: { entries: LibraryCard[] }) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">SAVED GAME / PLATFORM RECORDS</p>
          <h1>Your library.</h1>
          <p>
            Every game you send to SABnzbd stays here with its selected
            platform and complete attempt history.
          </p>
        </div>
        <Button asChild>
          <Link href={"/discover" as Route}><Plus aria-hidden="true" /> Find a game</Link>
        </Button>
      </header>
      {entries.length === 0 ? (
        <EmptyState
          eyebrow="SHELF 00"
          title="No saved games yet"
          action={<Button asChild><Link href={"/discover" as Route}>Open Discover</Link></Button>}
        >
          Search the catalog, choose a release, and it will appear here before
          Gamarr sends it to SABnzbd.
        </EmptyState>
      ) : (
        <div className="library-grid">
          {entries.map((entry, index) => (
            <Link className="library-card" href={`/library/${entry.id}` as Route} key={entry.id}>
              <div className="library-card-index mono">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div className="library-cover">
                {entry.coverUrl ? (
                  <Image src={entry.coverUrl} alt="" fill sizes="160px" />
                ) : <Gamepad2 aria-hidden="true" />}
              </div>
              <div className="library-card-copy">
                <p className="eyebrow">{entry.platformName}</p>
                <h2>{entry.gameTitle}</h2>
                {entry.latestAttempt ? (
                  <div className="latest-attempt">
                    <StatusPill
                      status={entry.latestAttempt.status}
                      label={entry.latestAttempt.status}
                    />
                    <span className="mono">
                      <Disc3 aria-hidden="true" />
                      {entry.latestAttempt.releaseTitle}
                    </span>
                  </div>
                ) : <span className="muted">No attempts recorded</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
