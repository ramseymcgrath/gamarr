"use client";

import {
  HardDriveDownload,
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
import {
  LibraryEntrySheet,
  useLibraryEntrySheet
} from "@/features/library/library-entry-sheet";
import { isModifiedClick, updateParams, useUrlParams } from "@/lib/url-state";

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
  /** A Verified PS2 download that can go into the Open PS2 Loader share. */
  exportable?: boolean;
  exportStatus?: "Pending" | "Running" | "Done" | "Failed" | null;
  /** Share-relative path(s), newline-separated. */
  exportPath?: string | null;
  exportDetail?: string | null;
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

function Ps2LibraryStatus({
  item,
  onExport
}: {
  item: ActivityItem;
  onExport: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const verification = item.verification;
  if (!verification?.exportable || verification.status !== "Verified") return null;
  const status = verification.exportStatus ?? null;
  const inFlight = status === "Pending" || status === "Running";
  const paths = verification.exportPath?.split("\n").filter(Boolean) ?? [];
  const pill = status === "Done"
    ? { tone: "ok", label: "In PS2 library" }
    : status === "Failed"
      ? { tone: "failed", label: "Not copied" }
      : status === "Running"
        ? { tone: "testing", label: "Copying…" }
        : status === "Pending"
          ? { tone: "queued", label: "Queued to copy" }
          : null;
  return (
    <div className="verification-bar ps2-library-bar">
      {pill && <StatusPill status={pill.tone} label={pill.label} />}
      <span className="verification-summary">
        {status === "Done" && paths.length > 0
          ? <span className="mono">{paths.join(", ")}</span>
          : status === null
            ? "Matches Redump. Copy it to the PS2's game share as a plain .iso."
            : verification.exportDetail}
      </span>
      {!inFlight && status !== "Done" && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onExport(item.id);
            } finally {
              setBusy(false);
            }
          }}
        >
          <HardDriveDownload aria-hidden="true" />
          {status === "Failed" ? "Try again" : "Add to PS2 library"}
        </Button>
      )}
    </div>
  );
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

const ACTIVITY_FILTERS = ["All", "Downloading", "Completed", "Failed", "Unknown"];

export function ActivityScreen({ initial }: { initial: ActivityItem[] }) {
  const [items, setItems] = useState(initial);
  // The filter lives in the URL so a reload or Back keeps it.
  const params = useUrlParams();
  const requested = params.get("status") ?? "All";
  const filter = ACTIVITY_FILTERS.includes(requested) ? requested : "All";
  const setFilter = (status: string) =>
    updateParams({ status: status === "All" ? null : status }, "replace");
  const sheet = useLibraryEntrySheet();
  const [message, setMessage] = useState<string | null>(null);
  const filtered = filter === "All"
    ? items
    : items.filter((item) => item.status === filter);
  const active = items.filter((item) =>
    ["Pending", "Submitting", "Queued", "Downloading", "Unknown"]
      .includes(item.status));

  const checking = items.some((item) =>
    item.verification?.status === "Pending"
    || item.verification?.status === "Running"
    || item.verification?.exportStatus === "Pending"
    || item.verification?.exportStatus === "Running");

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

  const requestExport = async (id: string) => {
    const response = await fetch(`/api/downloads/${encodeURIComponent(id)}/ps2-library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as
        { error?: { message?: string } } | null;
      setMessage(body?.error?.message ?? "Couldn't start copying to the PS2 library.");
      return;
    }
    const verification: ActivityVerification = await response.json();
    setItems((values) => values.map((value) =>
      value.id === id ? { ...value, verification } : value));
  };

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
      setMessage("Couldn't reach the download clients. Showing the last saved status.");
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Activity.</h1>
          <p>Every download sent to SABnzbd or qBittorrent, newest first.</p>
        </div>
        {active.length > 0 && (
          <Button variant="secondary" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" /> Refresh active
          </Button>
        )}
      </header>
      <div className="activity-toolbar">
        {ACTIVITY_FILTERS.map((status) => (
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
            <Link
              href={`/activity?entry=${item.libraryEntryId}` as Route}
              className="activity-row"
              scroll={false}
              onClick={(event) => {
                if (isModifiedClick(event)) return;
                event.preventDefault();
                sheet.open(item.libraryEntryId);
              }}
            >
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
            <Ps2LibraryStatus item={item} onExport={requestExport} />
            </div>
          ))}
        </div>
      )}
      <LibraryEntrySheet
        sheet={sheet}
        order={[...new Set(filtered.map((item) => item.libraryEntryId))]}
      />
    </div>
  );
}
