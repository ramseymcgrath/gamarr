"use client";

import {
  RefreshCw,
  Search,
  ShieldCheck
} from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";

export interface ActivityVerification {
  status:
    | "Pending"
    | "Running"
    | "Verified"
    | "Mismatch"
    | "Unknown"
    | "Unsupported"
    | "Failed";
  fileName: string | null;
  serial: string | null;
  redumpName: string | null;
  sha1: string | null;
  detail: string | null;
  checkedAt: number | null;
}

export interface ActivityItem {
  id: string;
  libraryEntryId: string;
  status: string;
  source?: "newznab" | "internet-archive" | "internet-archive-torrent";
  releaseTitle: string;
  indexerName: string;
  fileName?: string | null;
  size: number | null;
  category: string | null;
  progress: number;
  failureDetail: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  verification?: ActivityVerification | null;
}

const VERIFICATION_POLL_MS = 5_000;

/** Maps a verification outcome onto the shared status pill's palette. */
function verificationPill(status: ActivityVerification["status"]): {
  tone: string;
  label: string;
} {
  switch (status) {
    case "Verified": return { tone: "ok", label: "Verified (Redump)" };
    case "Mismatch": return { tone: "failed", label: "Mismatch" };
    case "Failed": return { tone: "failed", label: "Check failed" };
    case "Pending": return { tone: "queued", label: "Queued for check" };
    case "Running": return { tone: "testing", label: "Checking…" };
    case "Unknown": return { tone: "untested", label: "Not in Redump" };
    case "Unsupported": return { tone: "untested", label: "Can't verify" };
  }
}

function VerificationBar({
  item,
  onRequest
}: {
  item: ActivityItem;
  onRequest: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (item.status !== "Completed") return null;
  const verification = item.verification ?? null;
  const inFlight = verification?.status === "Pending"
    || verification?.status === "Running";
  const pill = verification ? verificationPill(verification.status) : null;
  const summary = verification?.status === "Verified"
    ? [verification.redumpName, verification.serial].filter(Boolean).join(" · ")
    : verification?.detail ?? "Not checked against Redump yet";

  return (
    <div className="verification-bar">
      {pill
        ? <StatusPill status={pill.tone} label={pill.label} />
        : <StatusPill status="untested" label="Not verified" />}
      <span className="verification-summary">
        {summary}
        {verification?.fileName && verification.status !== "Verified"
          && <span className="mono"> · {verification.fileName}</span>}
      </span>
      {!inFlight && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRequest(item.id);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ShieldCheck aria-hidden="true" /> {verification ? "Re-check" : "Verify"}
        </Button>
      )}
    </div>
  );
}

export function ActivityScreen({ initial }: { initial: ActivityItem[] }) {
  const [items, setItems] = useState(initial);
  const [filter, setFilter] = useState("All");
  const [message, setMessage] = useState<string | null>(null);
  const filtered = filter === "All"
    ? items
    : items.filter((item) => item.status === filter);
  const active = items.filter((item) =>
    ["Pending", "Submitting", "Queued", "Downloading", "Unknown"]
      .includes(item.status));

  const checking = items.some((item) =>
    item.verification?.status === "Pending"
    || item.verification?.status === "Running");

  // Hashing a disc image takes a while; poll only while a check is queued or
  // running, and only to pick up verification results.
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(async () => {
      const response = await fetch("/api/activity", { cache: "no-store" });
      if (!response.ok) return;
      const latest: ActivityItem[] = await response.json();
      const byId = new Map(latest.map((value) => [value.id, value]));
      setItems((values) => values.map((value) => {
        const fresh = byId.get(value.id);
        return fresh ? { ...value, verification: fresh.verification } : value;
      }));
    }, VERIFICATION_POLL_MS);
    return () => clearInterval(timer);
  }, [checking]);

  const requestVerification = async (id: string) => {
    const response = await fetch(`/api/downloads/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as
        { error?: { message?: string } } | null;
      setMessage(body?.error?.message ?? "Couldn't start the Redump check.");
      return;
    }
    const verification: ActivityVerification = await response.json();
    setItems((values) => values.map((value) =>
      value.id === id ? { ...value, verification } : value));
  };

  const refresh = async () => {
    const response = await fetch("/api/downloads/reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: active.map((item) => item.id) })
    });
    if (response.ok) {
      const updates: ActivityItem[] = await response.json();
      const byId = new Map(updates.map((value) => [value.id, value]));
      setItems((values) => values.map((value) => byId.get(value.id) ?? value));
      setMessage("Saved status refreshed");
    } else {
      setMessage("SABnzbd is unavailable; saved status is still shown.");
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">CHRONOLOGICAL ATTEMPT LOG</p>
          <h1>Activity.</h1>
          <p>Every retrieval and SABnzbd submission, newest first.</p>
        </div>
        {active.length > 0 && (
          <Button variant="secondary" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" /> Refresh active
          </Button>
        )}
      </header>
      <div className="activity-toolbar">
        {["All", "Downloading", "Completed", "Failed", "Unknown"].map((status) => (
          <button
            type="button"
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
            key={status}
          >
            {status}
          </button>
        ))}
      </div>
      {message && <p className="notice" role="status">{message}</p>}
      {filtered.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? "No download activity" : "No matching attempts"}
          action={items.length === 0
            ? <Button asChild><Link href={"/discover" as Route}><Search aria-hidden="true" /> Discover games</Link></Button>
            : undefined}
        >
          {items.length === 0
            ? "Your first release submission will be recorded here."
            : "Choose another status filter."}
        </EmptyState>
      ) : (
        <div className="activity-list">
          {filtered.map((item) => (
            <div className="activity-entry" key={item.id}>
            <Link href={`/library/${item.libraryEntryId}` as Route} className="activity-row">
              <time className="mono" dateTime={new Date(item.createdAt).toISOString()}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              <div>
                <strong>{item.releaseTitle}</strong>
                <span>
                  {item.source === "internet-archive-torrent"
                    ? "Internet Archive (torrent)"
                    : <>{item.indexerName} · {item.source === "internet-archive"
                      ? item.fileName ?? "Direct download"
                      : item.category ?? "Default category"}</>}
                </span>
                {item.failureDetail && <span className="failure-detail">{item.failureDetail}</span>}
              </div>
              <StatusPill status={item.status} label={item.status} />
              <progress max={100} value={item.progress}>{item.progress}%</progress>
            </Link>
            <VerificationBar item={item} onRequest={requestVerification} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
