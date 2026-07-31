import { getDatabase } from "@/db/client";

import { healthResponse } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return healthResponse({
    probe: () => {
      getDatabase().$client.prepare("select 1").get();
    }
  });
}
