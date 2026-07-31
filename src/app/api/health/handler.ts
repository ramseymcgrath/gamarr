export interface HealthDependencies {
  probe(): void;
}

export async function healthResponse(
  dependencies: HealthDependencies
): Promise<Response> {
  try {
    dependencies.probe();
    return Response.json({ status: "ok", database: "ok" });
  } catch {
    return Response.json(
      { status: "error", database: "error" },
      { status: 503 }
    );
  }
}
