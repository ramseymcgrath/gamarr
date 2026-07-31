"use client";

import {
  ArrowLeft,
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";

import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import type {
  LibraryAttempt,
  LibraryDetail
} from "@/features/library/models";

export function LibraryDetailScreen({ detail }: { detail: LibraryDetail }) {
  const [attempts, setAttempts] = useState(detail.attempts);
  const [message, setMessage] = useState<string | null>(null);
  const active = attempts.filter((attempt) =>
    ["Pending", "Submitting", "Queued", "Downloading", "Unknown"]
      .includes(attempt.status));
  const completed = attempts.find((attempt) => attempt.status === "Completed");
  const current = active[0] ?? attempts[0] ?? null;
  const previous = attempts.filter((attempt) =>
    attempt.id !== current?.id && attempt.id !== completed?.id);

  const refresh = async () => {
    const response = await fetch("/api/downloads/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: active.map((attempt) => attempt.id) })
    });
    if (!response.ok) {
      setMessage("Status refresh failed; saved state is still shown.");
      return;
    }
    const updates = await response.json();
    const byId = new Map(updates.map((value: LibraryAttempt) => [value.id, value]));
    setAttempts((values) => values.map((value) => ({
      ...value,
      ...(byId.get(value.id) ?? {})
    })));
    setMessage("Status refreshed");
  };

  const remove = async () => {
    const confirmation = prompt(`Type "${detail.gameTitle}" to remove this Gamarr record.`);
    if (confirmation === null) return;
    const response = await fetch(`/api/library/${detail.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation })
    });
    if (response.ok) location.href = "/";
    else setMessage("The title confirmation did not match.");
  };

  return (
    <div className="page">
      <Link className="back-link" href="/">
        <ArrowLeft aria-hidden="true" /> Back to library
      </Link>
      <header className="library-detail-header">
        <div className="library-detail-cover">
          {detail.coverUrl
            ? <Image src={detail.coverUrl} alt="" fill sizes="220px" />
            : <span aria-hidden="true">{detail.gameTitle.slice(0, 1)}</span>}
        </div>
        <div>
          <p className="eyebrow">{detail.platformName}</p>
          <h1>{detail.gameTitle}</h1>
          <p className="muted">
            Saved record · {attempts.length} {attempts.length === 1 ? "attempt" : "attempts"}
          </p>
          <div className="button-row detail-actions">
            <Button asChild>
              <Link href={`/discover/${detail.gameId}?platformId=${detail.platformId}` as Route}>
                <Search aria-hidden="true" /> Search again
              </Link>
            </Button>
            {active.length > 0 && (
              <Button variant="secondary" onClick={() => void refresh()}>
                <RefreshCw aria-hidden="true" /> Refresh status
              </Button>
            )}
            <Button variant="ghost" onClick={() => void remove()}>
              <Trash2 aria-hidden="true" /> Remove record
            </Button>
          </div>
          {message && <p role="status" className="notice">{message}</p>}
        </div>
      </header>

      <div className="attempt-sections">
        {current && (
          <AttemptSection
            title={active.length > 0 ? "Current attempt" : "Latest attempt"}
            attempt={current}
          />
        )}
        {completed && completed.id !== current?.id && (
          <AttemptSection title="Latest completed download" attempt={completed} />
        )}
        <section className="attempt-history">
          <h2>Previous attempts</h2>
          {previous.length === 0 ? (
            <p className="muted">No older attempts.</p>
          ) : (
            previous.map((attempt) => (
              <AttemptRow attempt={attempt} key={attempt.id} />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function AttemptSection({
  title,
  attempt
}: {
  title: string;
  attempt: LibraryAttempt;
}) {
  return (
    <section className="attempt-feature">
      <p className="eyebrow">{title}</p>
      <AttemptRow attempt={attempt} featured />
      {attempt.status === "Unknown" && (
        <p className="unknown-note">
          Gamarr will not resubmit this attempt automatically. Refresh its
          status or search again deliberately.
        </p>
      )}
    </section>
  );
}

function AttemptRow({
  attempt,
  featured = false
}: {
  attempt: LibraryAttempt;
  featured?: boolean;
}) {
  return (
    <article className={featured ? "attempt-row attempt-row-featured" : "attempt-row"}>
      <StatusPill status={attempt.status} label={attempt.status} />
      <div>
        <strong>{attempt.releaseTitle}</strong>
        <span className="mono">
          {new Date(attempt.createdAt).toLocaleString()}
        </span>
        {attempt.failureDetail && (
          <span className="failure-detail">Failed: {attempt.failureDetail}</span>
        )}
      </div>
      <progress max={100} value={attempt.progress}>
        {attempt.progress}%
      </progress>
    </article>
  );
}
