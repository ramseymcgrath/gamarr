import { forbiddenError, validationError } from "@/lib/errors";

export interface OriginPolicy {
  allowedOrigins: ReadonlySet<string>;
  trustedProxy: boolean;
  automationToken?: string;
}

export function parseOriginPolicy(
  value: string,
  options: { trustedProxy?: boolean; automationToken?: string } = {}
): OriginPolicy {
  const allowedOrigins = new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => new URL(item).origin)
  );
  if (allowedOrigins.size === 0) {
    throw validationError("GAMARR_ALLOWED_ORIGINS must contain at least one origin");
  }
  return {
    allowedOrigins,
    trustedProxy: options.trustedProxy ?? false,
    automationToken: options.automationToken
  };
}

function effectiveOrigin(request: Request, policy: OriginPolicy): string {
  const requestUrl = new URL(request.url);
  let protocol = requestUrl.protocol;
  let host = request.headers.get("host");

  if (policy.trustedProxy) {
    protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
      ? `${request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()}:`
      : protocol;
    host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? host;
  }
  if (!host) {
    throw forbiddenError();
  }
  return new URL(`${protocol}//${host}`).origin;
}

export function assertTrustedMutation(
  request: Request,
  policy: OriginPolicy
): void {
  const targetOrigin = effectiveOrigin(request, policy);
  if (!policy.allowedOrigins.has(targetOrigin)) {
    throw forbiddenError();
  }

  const origin = request.headers.get("origin");
  if (origin) {
    if (new URL(origin).origin !== targetOrigin || !policy.allowedOrigins.has(new URL(origin).origin)) {
      throw forbiddenError();
    }
    return;
  }

  const token = request.headers.get("x-gamarr-api-token");
  if (!policy.automationToken || token !== policy.automationToken) {
    throw forbiddenError();
  }
}
