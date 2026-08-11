import { qbittorrentTestDependencies } from "@/app/api/settings/dependencies";
import { handleTestQbittorrent } from "@/app/api/settings/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleTestQbittorrent(request, qbittorrentTestDependencies());
}
