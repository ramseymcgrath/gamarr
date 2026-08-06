/**
 * Next.js calls `register()` once per server process, before the first request
 * is served. That is the only place a one-shot startup task belongs: doing it
 * from a route's composition root instead made recovery re-run on every module
 * re-evaluation (dev HMR), which failed downloads that were still streaming.
 */
export async function register(): Promise<void> {
  // The composition root reaches SQLite through better-sqlite3, a native
  // module that must never be loaded on the edge runtime — hence both the
  // guard and the dynamic import.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { recoverDownloadsAtStartup } = await import(
      "@/app/api/downloads/dependencies"
    );
    // Returns false when the database has not been migrated yet, which is the
    // normal state on a fresh checkout and under e2e (Playwright starts the
    // web server before `globalSetup` migrates the fixture). That is a
    // deferral, not a failure: the composition root retries on first use, so
    // it is deliberately not reported here.
    recoverDownloadsAtStartup();
  } catch (error) {
    // Recovery is a repair pass over rows left behind by the previous process.
    // Failing it leaves those rows stale, which the next startup can still fix;
    // throwing here would take the whole server down instead.
    console.error("Startup download recovery failed", error);
  }
}
