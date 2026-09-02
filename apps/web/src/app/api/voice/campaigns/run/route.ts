import type { VoiceCampaignRun } from "@or-on/api-client";

import { voiceWrite } from "../../proxy";

export async function POST(request: Request) {
  return voiceWrite(request, async (client) => {
    const body = (await request.json()) as VoiceCampaignRun;
    return client.runVoiceCampaign(body);
  });
}
