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

interface CandidateFile {
  index: number;
  name: string;
  size: number | null;
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
  protocol,
  clientConfigured
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId: number;
  platformId: number;
  candidateId: string;
  title: string;
  indexerName: string;
  protocol: "usenet" | "torrent";
  clientConfigured: boolean;
}) {
  const submissionKey = `gamarr-${candidateId}-${useId()}`;
  const [state, setState] = useState<
    "confirm" | "submitting" | "queued" | "unknown" | "failed"
  >("confirm");
  const [files, setFiles] = useState<CandidateFile[] | null>(null);
  const [metadataPending, setMetadataPending] = useState(false);
  const [filesError, setFilesError] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<number[]>([]);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!open || protocol !== "torrent") return;
    let cancelled = false;
    const load = async () => {
      setFiles(null);
      setMetadataPending(false);
      setFilesError(false);
      setSelectedFiles([]);
      try {
        const response = await fetch(
          `/api/releases/files?candidateId=${encodeURIComponent(candidateId)}`
        );
        if (!response.ok) throw new Error();
        const body = await response.json() as {
          files?: CandidateFile[];
          metadataPending?: boolean;
        };
        if (cancelled) return;
        setFiles(body.files ?? []);
        setMetadataPending(body.metadataPending === true);
      } catch {
        if (!cancelled) setFilesError(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, protocol, candidateId]);

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
          ...(protocol === "torrent" && selectedFiles.length > 0
            ? { selectedFiles }
            : {})
        })
      });
      const body = await response.json() as {
        status?: "Unknown" | "Failed" | string;
        failureDetail?: string | null;
      };
      if (!response.ok) throw new Error();
      setState(body.status === "Unknown"
        ? "unknown"
        : body.status === "Failed" ? "failed" : "queued");
      setDetail(body.failureDetail ?? null);
    } catch {
      setState("failed");
      setDetail("Download submission failed");
    }
  };

  const clientName = protocol === "torrent" ? "qBittorrent" : "SABnzbd";
  const submitLabel = protocol === "torrent" ? "Send to qBittorrent" : "Send to SABnzbd";
  const toggleFile = (index: number) => setSelectedFiles((current) =>
    current.includes(index)
      ? current.filter((selected) => selected !== index)
      : [...current, index]
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Close className="dialog-close" aria-label="Close">
            <X aria-hidden="true" />
          </Dialog.Close>
          {state === "confirm" || state === "submitting" ? (
            <>
              <p className="eyebrow">CONFIRM DOWNLOAD</p>
              <Dialog.Title>{submitLabel}?</Dialog.Title>
              <Dialog.Description>
                {protocol === "torrent"
                  ? <>Gamarr will add this torrent from <strong>{indexerName}</strong> to qBittorrent.</>
                  : <>Gamarr will retrieve this NZB from <strong>{indexerName}</strong> and upload it to SABnzbd.</>}
              </Dialog.Description>
              <div className="dialog-release mono">{title}</div>
              {protocol === "torrent" && files === null && !filesError && (
                <p className="file-picker-status" role="status">Loading torrent files…</p>
              )}
              {protocol === "torrent" && filesError && (
                <p className="warning-banner" role="alert">Could not load torrent files.</p>
              )}
              {protocol === "torrent" && metadataPending && (
                <p className="file-picker-status">
                  The file list is not known until metadata arrives; the whole torrent will be added.
                </p>
              )}
              {protocol === "torrent" && files !== null && !metadataPending && files.length > 0 && (
                <fieldset className="file-picker">
                  <legend>Select torrent files (leave all unselected for the whole torrent)</legend>
                  {files.map((file) => (
                    <label className="file-option" key={file.index}>
                      <input
                        type="checkbox"
                        checked={selectedFiles.includes(file.index)}
                        onChange={() => toggleFile(file.index)}
                      />
                      <span className="file-option-name">{file.name}</span>
                      <span className="file-option-meta mono">{formatBytes(file.size)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {!clientConfigured && (
                <p className="warning-banner" role="alert">{clientName} is not configured</p>
              )}
              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <Button variant="secondary">Cancel</Button>
                </Dialog.Close>
                <Button
                  onClick={() => void submit()}
                  disabled={state === "submitting" || !clientConfigured}
                >
                  <Download aria-hidden="true" />
                  {state === "submitting" ? "Submitting…" : submitLabel}
                </Button>
              </div>
            </>
          ) : (
            <ResultState state={state} detail={detail} protocol={protocol} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResultState({
  state,
  detail,
  protocol
}: {
  state: "queued" | "unknown" | "failed";
  detail: string | null;
  protocol: "usenet" | "torrent";
}) {
  const queued = state === "queued";
  const clientName = protocol === "torrent" ? "qBittorrent" : "SABnzbd";
  return (
    <>
      {queued
        ? <CheckCircle2 className="dialog-result-icon success-icon" aria-hidden="true" />
        : <AlertTriangle className="dialog-result-icon warning-icon" aria-hidden="true" />}
      <Dialog.Title>
        {queued
          ? `Added to ${clientName}`
          : state === "unknown"
            ? "Submission status is unknown"
            : "Could not submit download"}
      </Dialog.Title>
      <Dialog.Description>
        {queued
          ? `The job is saved in your Gamarr library and queued in ${clientName}.`
          : state === "unknown"
            ? "Gamarr will not resubmit automatically. Refresh Activity to reconcile the durable marker."
            : detail ?? "Review your Prowlarr and download-client settings, then search again."}
      </Dialog.Description>
      <div className="dialog-actions">
        <Button asChild>
          <a href={queued ? "/" : "/activity"}>{queued ? "Open library" : "Open Activity"}</a>
        </Button>
        <Dialog.Close asChild>
          <Button variant="secondary">Close</Button>
        </Dialog.Close>
      </div>
    </>
  );
}
