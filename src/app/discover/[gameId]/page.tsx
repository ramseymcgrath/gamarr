import { redirect } from "next/navigation";

// Games open in a sheet over Discover; old links land there with their search.
export default async function GameDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ platformId?: string; q?: string }>;
}) {
  const [{ gameId }, query] = await Promise.all([params, searchParams]);
  const next = new URLSearchParams();
  if (query.platformId) next.set("platformId", query.platformId);
  if (query.q) next.set("q", query.q);
  next.set("game", gameId);
  redirect(`/discover?${next}`);
}
