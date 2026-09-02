import type { FlowDocumentRequest } from "@or-on/api-client";

import { voiceWrite } from "../../proxy";

export async function POST(request: Request) {
  return voiceWrite(request, async (client) => {
    const body = (await request.json()) as FlowDocumentRequest;
    return client.validateVoiceFlow(body);
  });
}
