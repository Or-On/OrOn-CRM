import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadConfig } from "@or-on/config";

import {
  MetaWhatsAppProvider,
  type WhatsAppDelivery,
} from "../src/providers.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (!process.argv.includes("--real"))
    throw new Error("refusing: pass --real to request an actual provider call");
  const recipient = argument("--recipient");
  const text = argument("--text");
  const template = argument("--template");
  const language = argument("--language") ?? "en_US";
  if (
    recipient === undefined ||
    (text === undefined) === (template === undefined)
  )
    throw new Error(
      "provide --recipient and exactly one of --text or --template",
    );
  const config = loadConfig(process.env, {
    requireWhatsApp: true,
    service: "whatsapp-smoke",
  });
  if (!config.enableRealWhatsApp)
    throw new Error(
      "refusing: ENABLE_REAL_WHATSAPP must explicitly equal true",
    );
  let delivery: WhatsAppDelivery;
  if (text !== undefined) {
    delivery = { kind: "text", text };
  } else {
    if (template === undefined) throw new Error("template is required");
    delivery = {
      kind: "template",
      templateName: template,
      language,
      parameters: (argument("--parameters") ?? "")
        .split("|")
        .map((value) => value.trim())
        .filter(Boolean),
    };
  }
  const suffix = recipient.slice(-4);
  const prompt = createInterface({ input: stdin, output: stdout });
  const confirmation = await prompt.question(
    `REAL Meta delivery (${delivery.kind}) to ***${suffix}. Type SEND_REAL_WHATSAPP to continue: `,
  );
  prompt.close();
  if (confirmation !== "SEND_REAL_WHATSAPP")
    throw new Error("cancelled: confirmation did not match");
  const provider = new MetaWhatsAppProvider({
    enabled: config.enableRealWhatsApp,
    accessToken: config.secrets.whatsappAccessToken,
    graphApiVersion: config.whatsApp.graphApiVersion,
    phoneNumberId: config.whatsApp.phoneNumberId,
  });
  const result = await provider.send({
    recipient,
    delivery,
    idempotencyKey: `manual-smoke-${Date.now().toString(36)}`,
  });
  stdout.write(
    `Meta accepted the message. ID suffix: ${result.messageId.slice(-8)}\n`,
  );
}

main().catch((error: unknown) => {
  const reason =
    error instanceof Error ? error.message : "unknown smoke-test failure";
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
});
