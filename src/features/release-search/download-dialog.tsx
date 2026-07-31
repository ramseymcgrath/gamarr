"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  X
} from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";

export function DownloadDialog({
  open,
  onOpenChange,
  gameId,
  platformId,
  candidateId,
  title,
  indexerName
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gameId: number;
  platformId: number;
  candidateId: string;
  title: string;
  indexerName: string;
}) {
  const submissionKey = `gamarr-${candidateId}-${useId()}`;
  const [state, setState] = useState<
    "confirm" | "submitting" | "queued" | "unknown" | "failed"
  >("confirm");
  const [detail, setDetail] = useState<string | null>(null);

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
          platformId
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
          ) : (
            <ResultState state={state} detail={detail} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResultState({
  state,
  detail
}: {
  state: "queued" | "unknown" | "failed";
  detail: string | null;
}) {
  const queued = state === "queued";
  return (
    <>
      {queued
        ? <CheckCircle2 className="dialog-result-icon success-icon" aria-hidden="true" />
        : <AlertTriangle className="dialog-result-icon warning-icon" aria-hidden="true" />}
      <Dialog.Title>
        {queued
          ? "Added to SABnzbd"
          : state === "unknown"
            ? "Submission status is unknown"
            : "Could not submit download"}
      </Dialog.Title>
      <Dialog.Description>
        {queued
          ? "The job is saved in your Gamarr library and queued for SABnzbd."
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
