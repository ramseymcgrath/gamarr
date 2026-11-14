import { redirect } from "next/navigation";

// Library records open in a sheet over the library; old links land there.
export default async function LibraryDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  redirect(`/?entry=${encodeURIComponent((await params).id)}`);
}
