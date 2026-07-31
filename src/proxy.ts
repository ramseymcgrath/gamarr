import { NextResponse } from "next/server";

import {
  assertTrustedMutation,
  parseOriginPolicy
} from "@/lib/trusted-mutation";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(request: Request): Response {
  if (SAFE_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  try {
    assertTrustedMutation(
      request,
      parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
        trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
        automationToken: process.env.GAMARR_API_TOKEN
      })
    );
    return NextResponse.next();
  } catch {
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Request origin is not allowed"
        }
      },
      { status: 403 }
    );
  }
}

export const config = {
  matcher: "/api/:path*"
};
