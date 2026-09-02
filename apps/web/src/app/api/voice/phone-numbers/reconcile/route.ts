import { voiceRead } from "../../proxy";

export const dynamic = "force-dynamic";

export async function GET() {
  return voiceRead((client) => client.reconcileVoicePhoneNumbers());
}
