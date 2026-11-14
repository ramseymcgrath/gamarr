"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A details sheet that slides over the list it belongs to, so the list (and
 * its scroll position and search) is still there when the sheet closes.
 * Radix supplies the focus trap, Escape, scroll lock and labelling.
 */
export function SideSheet({
  open,
  onClose,
  title,
  description,
  position,
  onPrevious,
  onNext,
  children
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** e.g. "3 of 12", shown between the stepping arrows. */
  position?: string;
  onPrevious?: (() => void) | null;
  onNext?: (() => void) | null;
  children: ReactNode;
}) {
  const stepping = onPrevious !== undefined || onNext !== undefined;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content
          className="side-sheet"
          onKeyDown={(event) => {
            if (event.target instanceof HTMLInputElement
              || event.target instanceof HTMLTextAreaElement
              || event.target instanceof HTMLSelectElement) return;
            if (event.key === "ArrowLeft" && onPrevious) onPrevious();
            if (event.key === "ArrowRight" && onNext) onNext();
          }}
        >
          <header className="sheet-header">
            <div className="sheet-heading">
              <Dialog.Title>{title}</Dialog.Title>
              {description
                ? <Dialog.Description>{description}</Dialog.Description>
                : <Dialog.Description className="sr-only">Details for {title}</Dialog.Description>}
            </div>
            {stepping && (
              <div className="sheet-stepper">
                <button
                  type="button"
                  aria-label="Previous"
                  disabled={!onPrevious}
                  onClick={() => onPrevious?.()}
                >
                  <ChevronLeft aria-hidden="true" />
                </button>
                {position && <span className="mono">{position}</span>}
                <button
                  type="button"
                  aria-label="Next"
                  disabled={!onNext}
                  onClick={() => onNext?.()}
                >
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
            )}
            <Dialog.Close className="sheet-close" aria-label="Close">
              <X aria-hidden="true" />
            </Dialog.Close>
          </header>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
