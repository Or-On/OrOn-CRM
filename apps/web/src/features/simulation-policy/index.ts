/** Simulator actions require an explicit development deployment, never a fallback. */
export function simulationRefusal(): Response | undefined {
  if (process.env.PLATFORM_ENV === "development") return undefined;
  return Response.json(
    {
      error: "Simulation is available only in a development environment",
      code: "simulation_disabled",
    },
    { status: 403 },
  );
}
