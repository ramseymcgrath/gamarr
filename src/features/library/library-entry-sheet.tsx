"use client";

import { useEffect, useState } from "react";

import { SideSheet } from "@/components/side-sheet";
import { LibraryDetailScreen } from "@/features/library/library-detail";
import type { LibraryDetail } from "@/features/library/models";
import { useSheetParam } from "@/lib/url-state";

/**
 * The library record for `?entry=<id>`, over whichever list opened it
 * (Library or Activity). `order` lets the sheet step to neighbouring records.
 */
export function useLibraryEntrySheet() {
  return useSheetParam("entry");
}

export function LibraryEntrySheet({
  sheet,
  order = [],
  initialDetail = null,
  onRemoved
}: {
  sheet: ReturnType<typeof useLibraryEntrySheet>;
  order?: string[];
  initialDetail?: LibraryDetail | null;
  onRemoved?: (id: string) => void;
}) {
  const id = sheet.value;
  const [loaded, setLoaded] = useState<
    { id: string; detail: LibraryDetail | "missing" } | null
  >(initialDetail ? { id: initialDetail.id, detail: initialDetail } : null);
  const current = loaded?.id === id ? loaded.detail : null;

  useEffect(() => {
    if (!id || loaded?.id === id) return;
    const controller = new AbortController();
    fetch(`/api/library/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        setLoaded({
          id,
          detail: response.ok ? await response.json() : "missing"
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ id, detail: "missing" });
      });
    return () => controller.abort();
  }, [id, loaded]);

  const index = id ? order.indexOf(id) : -1;
  const stepping = index >= 0 && order.length > 1;

  return (
    <SideSheet
      open={id !== null}
      onClose={sheet.close}
      title={current && current !== "missing" ? current.gameTitle : "Library record"}
      position={stepping ? `${index + 1} of ${order.length}` : undefined}
      onPrevious={stepping ? (index > 0 ? () => sheet.step(order[index - 1]!) : null) : undefined}
      onNext={stepping
        ? (index < order.length - 1 ? () => sheet.step(order[index + 1]!) : null)
        : undefined}
    >
      {current === "missing" ? (
        <p className="popular-note">This record no longer exists. It may have been removed.</p>
      ) : current ? (
        <LibraryDetailScreen
          key={current.id}
          detail={current}
          onRemoved={() => {
            sheet.close();
            onRemoved?.(current.id);
          }}
        />
      ) : (
        <p className="popular-note">Loading record…</p>
      )}
    </SideSheet>
  );
}
