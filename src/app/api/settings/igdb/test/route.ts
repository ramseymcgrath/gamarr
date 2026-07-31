import { catalogService } from "@/app/api/catalog/dependencies";
import { settingsDependencies } from "@/app/api/settings/dependencies";
import { AppError } from "@/lib/errors";
import { assertTrustedMutation } from "@/lib/trusted-mutation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedMutation(request, settingsDependencies().policy);
    await catalogService().testConnection();
    return Response.json({ status: "ok" });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    }
    return Response.json(
      { error: { code: "UNAVAILABLE", message: "IGDB connection failed" } },
      { status: 502 }
    );
  }
}
