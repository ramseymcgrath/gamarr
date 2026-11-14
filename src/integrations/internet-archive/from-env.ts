import { InternetArchiveClient } from "@/integrations/internet-archive/client";

/**
 * Internet Archive is on unless `GAMARR_INTERNET_ARCHIVE=false`.
 * `GAMARR_IA_BASE_URL` is a test-only override pointing at the e2e stub server.
 */
export function internetArchiveClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): InternetArchiveClient | null {
  if (env.GAMARR_INTERNET_ARCHIVE?.trim().toLowerCase() === "false") {
    return null;
  }
  return new InternetArchiveClient({
    baseUrl: env.GAMARR_IA_BASE_URL || undefined
  });
}
