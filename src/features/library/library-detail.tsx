"use client";

import {
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { useId, useState, type FormEvent } from "react";

import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  LibraryAttempt,
  LibraryDetail
} from "@/features/library/models";

/**
 * A saved game's record and attempt history, shown in the library sheet.
 * `onRemoved` lets the host close the sheet and drop the card.
 */
export function LibraryDetailScreen({
  detail,
  onRemoved
}: {
  detail: LibraryDetail;
  onRemoved?: () => void;
}) {
  const [attempts, setAttempts] = useState(detail.attempts);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const confirmId = useId();
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

  const remove = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(`/api/library/${detail.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation })
    });
    if (!response.ok) {
      setMessage("That isn't the exact title, so nothing was removed.");
      return;
    }
    if (onRemoved) onRemoved();
    else location.href = "/";
  };

  return (
    <div className="library-panel">
      <header className="library-detail-header">
        <div className="library-detail-cover">
          {detail.coverUrl
            ? <Image src={detail.coverUrl} alt="" fill sizes="220px" />
            : <span aria-hidden="true">{detail.gameTitle.slice(0, 1)}</span>}
        </div>
        <div>
          <p className="game-panel-meta">{detail.platformName}</p>
          <p className="muted">
            {attempts.length} download {attempts.length === 1 ? "attempt" : "attempts"}
          </p>
          <div className="button-row detail-actions">
            <Button asChild>
              <Link href={`/discover?platformId=${detail.platformId}&game=${detail.gameId}` as Route}>
                <Search aria-hidden="true" /> Search again
              </Link>
            </Button>
            {active.length > 0 && (
              <Button variant="secondary" onClick={() => void refresh()}>
                <RefreshCw aria-hidden="true" /> Refresh status
              </Button>
            )}
            <Button
              variant="ghost"
              aria-expanded={confirming}
              aria-controls={confirmId}
              onClick={() => setConfirming((value) => !value)}
            >
              <Trash2 aria-hidden="true" /> Remove from library
            </Button>
          </div>
          {confirming && (
            <form id={confirmId} className="remove-confirm" onSubmit={(event) => void remove(event)}>
              <label htmlFor={`${confirmId}-title`}>
                Type <strong>{detail.gameTitle}</strong> to remove it from
                Gamarr. Downloaded files are not touched.
              </label>
              <div>
                <Input
                  id={`${confirmId}-title`}
                  value={confirmation}
                  autoComplete="off"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={confirmation !== detail.gameTitle}
                >
                  Remove
                </Button>
              </div>
            </form>
          )}
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
          <h3>Previous attempts</h3>
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
