"use client";

import {
  RefreshCw,
  Search
} from "lucide-react";
import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";

export interface ActivityItem {
  id: string;
  libraryEntryId: string;
  status: string;
  source?: "newznab" | "internet-archive";
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
            <Link href={`/library/${item.libraryEntryId}` as Route} className="activity-row" key={item.id}>
              <time className="mono" dateTime={new Date(item.createdAt).toISOString()}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
              <div>
                <strong>{item.releaseTitle}</strong>
                <span>
                  {item.indexerName} · {item.source === "internet-archive"
                    ? item.fileName ?? "Direct download"
                    : item.category ?? "Default category"}
                </span>
                {item.failureDetail && <span className="failure-detail">{item.failureDetail}</span>}
              </div>
              <StatusPill status={item.status} label={item.status} />
              <progress max={100} value={item.progress}>{item.progress}%</progress>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
