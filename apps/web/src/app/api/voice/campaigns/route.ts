import type { VoiceCampaignCreate } from "@or-on/api-client";

import { voiceManage, voiceRead } from "../proxy";

export async function GET() {
  return voiceRead((client) => client.listVoiceCampaigns());
}

export async function POST(request: Request) {
  return voiceManage(request, async (client) => {
    const body = (await request.json()) as VoiceCampaignCreate;
    return client.createVoiceCampaign(body);
  });
}
