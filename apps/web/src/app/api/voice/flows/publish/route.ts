import type { FlowDocumentRequest } from "@or-on/api-client";

import { voiceManage } from "../../proxy";

export async function POST(request: Request) {
  return voiceManage(request, async (client) => {
    const body = (await request.json()) as FlowDocumentRequest;
    return client.publishVoiceFlow(body);
  });
}
