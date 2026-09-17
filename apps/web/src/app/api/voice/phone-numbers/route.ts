import type { RegisterPhoneNumberRequest } from "@or-on/api-client";

import { voiceManage, voiceRead } from "../proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return voiceRead((client) => client.listVoicePhoneNumbers());
}

export async function POST(request: Request) {
  return voiceManage(request, async (client) => {
    const body = (await request.json()) as RegisterPhoneNumberRequest;
    return client.registerVoicePhoneNumber(body);
  });
}
