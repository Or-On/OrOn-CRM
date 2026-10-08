import { voiceRead } from "../../../../proxy";
export async function GET(
  _request: Request,
  context: { params: Promise<{ flowId: string; version: string }> },
) {
  const { flowId, version } = await context.params;
  if (!/^[1-9]\d*$/u.test(version))
    return Response.json({ error: "Invalid version" }, { status: 400 });
  return voiceRead((client) =>
    client.getVoiceFlowSource(flowId, Number(version)),
  );
}
