import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteLibraryRepository } from "@/features/library/repository";
import { LibraryService } from "@/features/library/service";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function libraryDependencies() {
  return {
    service: new LibraryService(
      new SqliteLibraryRepository(getDatabase())
    ),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
