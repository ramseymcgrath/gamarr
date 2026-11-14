import { errorResponse } from "@/app/api/error-response";
import type {
  DownloadAttempt,
  SubmitDownloadInput
} from "@/features/downloads/models";
import type { DownloadVerification } from "@/features/verification/models";
import { validationError } from "@/lib/errors";
import {
  assertTrustedMutation,
  type OriginPolicy
} from "@/lib/trusted-mutation";

interface DownloadHandlerService {
  submit(input: SubmitDownloadInput): Promise<DownloadAttempt>;
  reconcile(ids?: string[]): Promise<DownloadAttempt[]>;
}

export function toPublicVerification(
  verification: DownloadVerification,
  exportable = false
) {
  return {
    exportable,
    status: verification.status,
    fileName: verification.fileName,
    serial: verification.serial,
    redumpName: verification.redumpName,
    sha1: verification.sha1,
    detail: verification.detail,
    checkedAt: verification.checkedAt,
    exportStatus: verification.exportStatus,
    exportPath: verification.exportPath,
    exportDetail: verification.exportDetail
  };
}

export function toPublicAttempt(
  attempt: DownloadAttempt,
  verification?: DownloadVerification | null,
  exportable = false
) {
  return {
    id: attempt.id,
    libraryEntryId: attempt.libraryEntryId,
    status: attempt.status,
    source: attempt.source,
    releaseTitle: attempt.releaseTitle,
    indexerName: attempt.indexerNameSnapshot,
    fileName: attempt.iaFileName,
    size: attempt.size,
    category: attempt.category,
    progress: attempt.progress,
    failureDetail: attempt.failureDetail,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    completedAt: attempt.completedAt,
    verification: verification ? toPublicVerification(verification, exportable) : null
  };
}

export async function handleVerifyDownload(
  request: Request,
  attemptId: string,
  dependencies: {
    service: {
      request(attemptId: string): DownloadVerification;
      canExport(attemptId: string): boolean;
    };
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    if (!attemptId || attemptId.length > 200) {
      throw validationError("Invalid download id");
    }
    return Response.json(
      toPublicVerification(
        dependencies.service.request(attemptId),
        dependencies.service.canExport(attemptId)
      ),
      { status: 202 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/** Queues a copy of a verified PS2 download into the Open PS2 Loader share. */
export async function handleExportDownload(
  request: Request,
  attemptId: string,
  dependencies: {
    service: { requestExport(attemptId: string): DownloadVerification };
    // Reaching requestExport successfully means the download is exportable.
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    if (!attemptId || attemptId.length > 200) {
      throw validationError("Invalid download id");
    }
    return Response.json(
      toPublicVerification(dependencies.service.requestExport(attemptId), true),
      { status: 202 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleSubmitDownload(
  request: Request,
  dependencies: {
    service: DownloadHandlerService;
    policy: OriginPolicy;
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as Partial<SubmitDownloadInput>;
    if (
      typeof body.submissionKey !== "string" ||
      typeof body.candidateId !== "string" ||
      !Number.isInteger(body.gameId) ||
      !Number.isInteger(body.platformId) ||
      (body.selectedFiles !== undefined && (
        !Array.isArray(body.selectedFiles)
        || !body.selectedFiles.every((index) =>
          Number.isInteger(index) && index >= 0)
      ))
    ) {
      throw validationError("Invalid download submission");
    }
    const result = await dependencies.service.submit(
      body as SubmitDownloadInput
    );
    return Response.json(toPublicAttempt(result), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReconcileDownloads(
  request: Request,
  dependencies: {
    service: DownloadHandlerService;
    policy: OriginPolicy;
    verifications?: { get(attemptId: string): DownloadVerification | null };
  }
): Promise<Response> {
  try {
    assertTrustedMutation(request, dependencies.policy);
    const body = await request.json() as { ids?: unknown };
    if (
      body.ids !== undefined &&
      (!Array.isArray(body.ids) ||
        !body.ids.every((id) => typeof id === "string"))
    ) {
      throw validationError("ids must be an array of strings");
    }
    const results = await dependencies.service.reconcile(
      body.ids as string[] | undefined
    );
    return Response.json(results.map((attempt) => toPublicAttempt(
      attempt,
      dependencies.verifications?.get(attempt.id)
    )), {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return errorResponse(error);
  }
}
