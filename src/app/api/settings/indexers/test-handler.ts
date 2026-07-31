import type { IndexerRecord } from "@/features/settings/models";
import type { NewznabCapabilities } from "@/integrations/newznab/client";
import { AppError, validationError } from "@/lib/errors";
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
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const indexer = dependencies.findIndexer(id);
    if (!indexer || indexer.deletedAt !== null) {
      throw validationError("Indexer does not exist");
    }
    return Response.json(
      await dependencies.clientFactory(indexer).getCapabilities(),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    return Response.json(
      { error: { code: "INTERNAL", message: "Unexpected server error" } },
      { status: 500 }
    );
  }
}
