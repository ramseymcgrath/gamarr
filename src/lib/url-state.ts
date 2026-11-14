"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useReducer } from "react";

/**
 * Screen state that should survive Back/Forward, reloads and shared links
 * (the search query, the open game, the open library record) lives in the
 * URL's search params. Updates go through the native History API, which
 * Next.js integrates with its router without a server round trip.
 */
const URL_CHANGE_EVENT = "gamarr:urlchange";

export type ParamUpdates = Record<string, string | number | null | undefined>;

export function hrefWithParams(updates: ParamUpdates, base?: string): string {
  const url = new URL(base ?? window.location.href, window.location.origin);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `push` adds a Back step; `replace` refines the current one. */
export function updateParams(
  updates: ParamUpdates,
  mode: "push" | "replace"
): void {
  const next = hrefWithParams(updates);
  if (mode === "push") window.history.pushState(null, "", next);
  else window.history.replaceState(null, "", next);
  window.dispatchEvent(new Event(URL_CHANGE_EVENT));
}

/**
 * The current URL's search params, re-read on Back/Forward, on
 * `updateParams`, and on Next.js navigations.
 */
export function useUrlParams(): URLSearchParams {
  // Next's params are authoritative: on a client navigation (a <Link> into
  // this page) the new screen renders before `location` is updated, so
  // reading `location` there would see the previous page's URL. Next also
  // folds native pushState/replaceState into these params. `location` is only
  // the fallback outside the App Router (unit tests).
  const nextParams = useSearchParams();
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    window.addEventListener(URL_CHANGE_EVENT, rerender);
    window.addEventListener("popstate", rerender);
    return () => {
      window.removeEventListener(URL_CHANGE_EVENT, rerender);
      window.removeEventListener("popstate", rerender);
    };
  }, []);
  if (nextParams) return new URLSearchParams(nextParams.toString());
  return new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search
  );
}

/** True for clicks the browser should handle itself (new tab, window…). */
export function isModifiedClick(event: React.MouseEvent): boolean {
  return event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey;
}

/**
 * Open/close for a sheet keyed by one search param. Opening pushes a history
 * entry so Back closes the sheet; stepping between items replaces it so Back
 * still closes rather than walking through every item viewed. Closing a sheet
 * that was opened by a direct link removes the param instead of leaving the app.
 */
export function useSheetParam(name: string) {
  const params = useUrlParams();
  const value = params.get(name);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  return {
    value,
    open(id: string | number) {
      sheetsOpenedInApp.add(name);
      updateParams({ [name]: id }, "push");
      rerender();
    },
    step(id: string | number) {
      updateParams({ [name]: id }, "replace");
    },
    close() {
      if (sheetsOpenedInApp.delete(name)) window.history.back();
      else updateParams({ [name]: null }, "replace");
    }
  };
}

const sheetsOpenedInApp = new Set<string>();

if (typeof window !== "undefined") {
  // Back (or Forward) moved off the entry we pushed; a later close must not
  // pop a second history entry.
  window.addEventListener("popstate", () => sheetsOpenedInApp.clear());
}
