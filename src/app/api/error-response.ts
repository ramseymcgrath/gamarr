import { AppError, type AppErrorCode } from "@/lib/errors";

export interface ErrorResponseFallback {
  code: AppErrorCode;
  message: string;
  status: number;
}

const defaultFallback: ErrorResponseFallback = {
  code: "INTERNAL",
  message: "Unexpected server error",
  status: 500
};

/**
 * `Response.json` silently defaults an `undefined` status to 200 and throws a
 * `RangeError` for values outside 200-599. Either turns a failure into a
 * non-error response, so anything that is not a well-formed error status is
 * reported as 500.
 */
function safeStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500;
}

export function errorResponse(
  error: unknown,
  fallback: ErrorResponseFallback = defaultFallback
): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: safeStatus(error.status) }
    );
  }
  return Response.json(
    { error: { code: fallback.code, message: fallback.message } },
    { status: fallback.status }
  );
}
