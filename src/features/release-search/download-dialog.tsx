"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  X
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ReleaseSourceType } from "@/features/release-search/models";

interface CandidateFile {
  name: string;
  size: number | null;
  format: string | null;
}

interface ItemTorrent {
  name: string;
  size: number | null;
}

type DownloadSelection =
  | { kind: "torrent" }
  | { kind: "file"; name: string };

function formatBytes(value: number | null): string {
  if (value === null) return "size unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

export function DownloadDialog({
  open,
  onOpenChange,
  gameId,
  platformId,
  candidateId,
  title,
  indexerName,
  source
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId: number;
  platformId: number;
  candidateId: string;
  title: string;
  indexerName: string;
  source: ReleaseSourceType;
}) {
  const submissionKey = `gamarr-${candidateId}-${useId()}`;
  const isArchive = source === "internet-archive";
  const [state, setState] = useState<
    "confirm" | "submitting" | "queued" | "unknown" | "failed"
  >("confirm");
  const [detail, setDetail] = useState<string | null>(null);
  const [files, setFiles] = useState<CandidateFile[] | null>(null);
  const [torrent, setTorrent] = useState<ItemTorrent | null>(null);
  const [torrentClientConfigured, setTorrentClientConfigured] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selection, setSelection] = useState<DownloadSelection | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Internet Archive items bundle many files; the payload choice is part of
  // the manual selection, so the list loads when the dialog opens.
  useEffect(() => {
    if (!open || !isArchive) return;
    let cancelled = false;
    const load = async () => {
      setFiles(null);
      setTorrent(null);
      setTorrentClientConfigured(false);
      setFilesError(null);
      setSelection(null);
      try {
        const response = await fetch(
          `/api/releases/files?candidateId=${encodeURIComponent(candidateId)}`
        );
        const body = await response.json() as {
          files?: CandidateFile[];
          torrent?: ItemTorrent | null;
          torrentClientConfigured?: boolean;
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(
            body.error?.message ?? "Could not load the item files"
          );
        }
        if (cancelled) return;
        const items = body.files ?? [];
        setFiles(items);
        setTorrent(body.torrent ?? null);
        setTorrentClientConfigured(body.torrentClientConfigured ?? false);
        // The endpoint already sorts largest-first, so the preselection is
        // the most likely payload. Keep the established direct-download
        // gesture even when the item also offers a torrent.
        setSelection(items[0] ? { kind: "file", name: items[0].name } : null);
      } catch (error) {
        if (!cancelled) {
          setFilesError(error instanceof Error
            ? error.message
            : "Could not load the item files");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, isArchive, candidateId, reloadToken]);

  const submit = async () => {
    setState("submitting");
    setDetail(null);
    try {
      const response = await fetch("/api/downloads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionKey,
          candidateId,
          gameId,
          platformId,
          ...(isArchive && selection?.kind === "torrent"
            ? { delivery: "torrent" as const }
            : isArchive && selection?.kind === "file"
              ? { delivery: "file" as const, fileName: selection.name }
              : {})
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Download failed");
      if (body.status === "Unknown") {
        setState("unknown");
      } else if (body.status === "Failed") {
        setState("failed");
      } else {
        setState("queued");
      }
      setDetail(body.failureDetail ?? null);
    } catch (error) {
      setState("failed");
      setDetail(error instanceof Error ? error.message : "Download failed");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Close className="dialog-close" aria-label="Close">
            <X aria-hidden="true" />
          </Dialog.Close>
          {state === "confirm" || state === "submitting" ? (
            isArchive ? (
              <ArchiveConfirm
                title={title}
                indexerName={indexerName}
                files={files}
                torrent={torrent}
                torrentClientConfigured={torrentClientConfigured}
                filesError={filesError}
                selection={selection}
                onSelect={setSelection}
                onRetry={() => setReloadToken((value) => value + 1)}
                submitting={state === "submitting"}
                onSubmit={() => void submit()}
              />
            ) : (
              <>
                <p className="eyebrow">CONFIRM DOWNLOAD</p>
                <Dialog.Title>Send to SABnzbd?</Dialog.Title>
                <Dialog.Description>
                  Gamarr will retrieve this NZB from <strong>{indexerName}</strong>,
                  validate its size, and upload it to SABnzbd.
                </Dialog.Description>
                <div className="dialog-release mono">{title}</div>
                <div className="dialog-actions">
                  <Dialog.Close asChild>
                    <Button variant="secondary">Cancel</Button>
                  </Dialog.Close>
                  <Button onClick={() => void submit()} disabled={state === "submitting"}>
                    <Download aria-hidden="true" />
                    {state === "submitting" ? "Retrieving and sending…" : "Send to SABnzbd"}
                  </Button>
                </div>
              </>
            )
          ) : (
            <ResultState
              state={state}
              detail={detail}
              isArchive={isArchive}
              isTorrent={isArchive && selection?.kind === "torrent"}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ArchiveConfirm({
  title,
  indexerName,
  files,
  torrent,
  torrentClientConfigured,
  filesError,
  selection,
  onSelect,
  onRetry,
  submitting,
  onSubmit
}: {
  title: string;
  indexerName: string;
  files: CandidateFile[] | null;
  torrent: ItemTorrent | null;
  torrentClientConfigured: boolean;
  filesError: string | null;
  selection: DownloadSelection | null;
  onSelect: (selection: DownloadSelection) => void;
  onRetry: () => void;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const torrentSelected = selection?.kind === "torrent";
  return (
    <>
      <p className="eyebrow">CONFIRM DOWNLOAD</p>
      <Dialog.Title>Download from Internet Archive?</Dialog.Title>
      <Dialog.Description>
        Choose a file to save from <strong>{indexerName}</strong>, or send the
        {" "}entire item to qBittorrent. Track progress in Activity.
      </Dialog.Description>
      <div className="dialog-release mono">{title}</div>
      {files === null && filesError === null && (
        <p className="file-picker-status" role="status">Loading item files…</p>
      )}
      {filesError !== null && (
        <>
          <div className="warning-banner">
            <AlertTriangle aria-hidden="true" />
            <div>
              <strong>Could not load files</strong>
              <span>{filesError}</span>
            </div>
          </div>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button variant="secondary" onClick={onRetry}>Try again</Button>
          </div>
        </>
      )}
      {files !== null && files.length === 0 && torrent === null && filesError === null && (
        <p className="file-picker-status" role="status">
          This item has no downloadable files.
        </p>
      )}
      {files !== null && (files.length > 0 || torrent !== null) && (
        <>
          <fieldset className="file-picker">
            <legend>Select what to download</legend>
            {torrent !== null && (
              <>
                <label className="file-option">
                  <input
                    type="radio"
                    name="internet-archive-download"
                    value="torrent"
                    checked={torrentSelected}
                    disabled={!torrentClientConfigured}
                    onChange={() => onSelect({ kind: "torrent" })}
                  />
                  <span className="file-option-name">Entire item (torrent)</span>
                  <span className="file-option-meta mono">
                    {torrentClientConfigured
                      ? `${formatBytes(torrent.size)} · via qBittorrent`
                      : "qBittorrent is not configured"}
                  </span>
                </label>
                {files.length > 0 && <hr className="file-picker-divider" />}
              </>
            )}
            {files.map((file) => (
              <label className="file-option" key={file.name}>
                <input
                  type="radio"
                  name="internet-archive-download"
                  value={file.name}
                  checked={selection?.kind === "file" && selection.name === file.name}
                  onChange={() => onSelect({ kind: "file", name: file.name })}
                />
                <span className="file-option-name">{file.name}</span>
                <span className="file-option-meta mono">
                  {[file.format, formatBytes(file.size)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="secondary">Cancel</Button>
            </Dialog.Close>
            <Button onClick={onSubmit} disabled={submitting || selection === null}>
              <Download aria-hidden="true" />
              {submitting
                ? torrentSelected ? "Sending to qBittorrent…" : "Starting download…"
                : torrentSelected ? "Send to qBittorrent" : "Download file"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function ResultState({
  state,
  detail,
  isArchive,
  isTorrent
}: {
  state: "queued" | "unknown" | "failed";
  detail: string | null;
  isArchive: boolean;
  isTorrent: boolean;
}) {
  const queued = state === "queued";
  return (
    <>
      {queued
        ? <CheckCircle2 className="dialog-result-icon success-icon" aria-hidden="true" />
        : <AlertTriangle className="dialog-result-icon warning-icon" aria-hidden="true" />}
      <Dialog.Title>
        {queued
          ? isTorrent
            ? "Added to qBittorrent"
            : isArchive ? "Download started" : "Added to SABnzbd"
          : state === "unknown"
            ? "Submission status is unknown"
            : "Could not submit download"}
      </Dialog.Title>
      <Dialog.Description>
        {queued
          ? isTorrent
            ? "The job is saved in your Gamarr library and queued in qBittorrent."
            : isArchive
            ? "The job is saved in your Gamarr library and the file is downloading to this machine."
            : "The job is saved in your Gamarr library and queued for SABnzbd."
          : state === "unknown"
            ? "Gamarr will not resubmit automatically. Refresh Activity to reconcile the durable marker."
            : detail ?? "Review your indexer and SABnzbd settings, then search again."}
      </Dialog.Description>
      <div className="dialog-actions">
        <Button asChild>
          <a href={queued ? "/" : "/activity"}>
            {queued ? "Open library" : "Open Activity"}
          </a>
        </Button>
        <Dialog.Close asChild>
          <Button variant="secondary">Close</Button>
        </Dialog.Close>
      </div>
    </>
  );
}
