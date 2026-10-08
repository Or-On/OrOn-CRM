import { voiceRead } from "../proxy";
export async function GET() {
  return voiceRead((client) => client.listVoiceFlows());
}
