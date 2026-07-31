import { errorResponse } from "@/app/api/error-response";
import type { IndexerRecord } from "@/features/settings/models";
import type { NewznabCapabilities } from "@/integrations/newznab/client";
import { validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

interface CapabilitiesClient {
  getCapabilities(): Promise<NewznabCapabilities>;
}

export async function handleTestIndexer(
  id: string,
  request: Request,
  dependencies: {
    policy: OriginPolicy;
    findIndexer: (id: string) => IndexerRecord | null;
    clientFactory: (indexer: IndexerRecord) => CapabilitiesClient;
    recordResult?: (id: string, status: string) => void;
  }
): Promise<Response> {
  let trusted = false;
  try {
    assertTrustedMutation(request, dependencies.policy);
    trusted = true;
    const indexer = dependencies.findIndexer(id);
    if (!indexer || indexer.deletedAt !== null) {
      throw validationError("Indexer does not exist");
    }
    const capabilities = await dependencies.clientFactory(indexer).getCapabilities();
    dependencies.recordResult?.(id, "ok");
    return Response.json(
      capabilities,
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (trusted) dependencies.recordResult?.(id, "failed");
    return errorResponse(error);
  }
}
