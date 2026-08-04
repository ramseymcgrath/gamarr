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
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Internet Archive items bundle many files; the payload choice is part of
  // the manual selection, so the list loads when the dialog opens.
  useEffect(() => {
    if (!open || !isArchive) return;
    let cancelled = false;
    const load = async () => {
      setFiles(null);
      setFilesError(null);
      setSelectedFile(null);
      try {
        const response = await fetch(
          `/api/releases/files?candidateId=${encodeURIComponent(candidateId)}`
        );
        const body = await response.json() as {
          files?: CandidateFile[];
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
        // The endpoint already sorts largest-first, so the preselection is
        // the most likely payload, and it remains only a default.
        setSelectedFile(items[0]?.name ?? null);
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
          ...(isArchive && selectedFile ? { fileName: selectedFile } : {})
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
                filesError={filesError}
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
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
            <ResultState state={state} detail={detail} isArchive={isArchive} />
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
  filesError,
  selectedFile,
  onSelectFile,
  onRetry,
  submitting,
  onSubmit
}: {
  title: string;
  indexerName: string;
  files: CandidateFile[] | null;
  filesError: string | null;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  onRetry: () => void;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      <p className="eyebrow">CONFIRM DOWNLOAD</p>
      <Dialog.Title>Download from Internet Archive?</Dialog.Title>
      <Dialog.Description>
        Gamarr will download the selected file from <strong>{indexerName}</strong>
        {" "}and save it on this machine. Track progress in Activity.
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
      {files !== null && files.length === 0 && filesError === null && (
        <p className="file-picker-status" role="status">
          This item has no downloadable files.
        </p>
      )}
      {files !== null && files.length > 0 && (
        <>
          <fieldset className="file-picker">
            <legend>Select a file to download</legend>
            {files.map((file) => (
              <label className="file-option" key={file.name}>
                <input
                  type="radio"
                  name="internet-archive-file"
                  value={file.name}
                  checked={selectedFile === file.name}
                  onChange={() => onSelectFile(file.name)}
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
            <Button onClick={onSubmit} disabled={submitting || !selectedFile}>
              <Download aria-hidden="true" />
              {submitting ? "Starting download…" : "Download file"}
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
  isArchive
}: {
  state: "queued" | "unknown" | "failed";
  detail: string | null;
  isArchive: boolean;
}) {
  const queued = state === "queued";
  return (
    <>
      {queued
        ? <CheckCircle2 className="dialog-result-icon success-icon" aria-hidden="true" />
        : <AlertTriangle className="dialog-result-icon warning-icon" aria-hidden="true" />}
      <Dialog.Title>
        {queued
          ? isArchive ? "Download started" : "Added to SABnzbd"
          : state === "unknown"
            ? "Submission status is unknown"
            : "Could not submit download"}
      </Dialog.Title>
      <Dialog.Description>
        {queued
          ? isArchive
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
