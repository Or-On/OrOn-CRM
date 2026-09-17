import type { VoiceCampaignRun } from "@or-on/api-client";

import { voiceManage } from "../../proxy";

export async function POST(request: Request) {
  return voiceManage(request, async (client) => {
    const body = (await request.json()) as VoiceCampaignRun;
    return client.runVoiceCampaign(body);
  });
}
