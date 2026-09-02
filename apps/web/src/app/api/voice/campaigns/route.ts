import type { VoiceCampaignCreate } from "@or-on/api-client";

import { voiceRead, voiceWrite } from "../proxy";

export async function GET() {
  return voiceRead((client) => client.listVoiceCampaigns());
}

export async function POST(request: Request) {
  return voiceWrite(request, async (client) => {
    const body = (await request.json()) as VoiceCampaignCreate;
    return client.createVoiceCampaign(body);
  });
}
