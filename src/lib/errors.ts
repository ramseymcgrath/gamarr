export type AppErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    public readonly status: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function validationError(message: string, options?: ErrorOptions) {
  return new AppError("VALIDATION", 400, message, options);
}

export function forbiddenError(message = "Request origin is not allowed") {
  return new AppError("FORBIDDEN", 403, message);
}
