import type { RegisterPhoneNumberRequest } from "@or-on/api-client";

import { voiceRead, voiceWrite } from "../proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return voiceRead((client) => client.listVoicePhoneNumbers());
}

export async function POST(request: Request) {
  return voiceWrite(request, async (client) => {
    const body = (await request.json()) as RegisterPhoneNumberRequest;
    return client.registerVoicePhoneNumber(body);
  });
}
