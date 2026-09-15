import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { hashPassword } from "../packages/ts/auth/src/crypto.js";

interface Options {
  source: string;
  output: string;
  origin: string;
  database: string;
  ownerEmail: string;
  tenantName: string;
  tenantSlug: string;
  tlsEmail: string;
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function options(): Options {
  const parsed = {
    source: resolve(option("--source")),
    output: resolve(option("--output")),
    origin: option("--origin"),
    database: option("--database"),
    ownerEmail: option("--owner-email").toLowerCase(),
    tenantName: option("--tenant-name"),
    tenantSlug: option("--tenant-slug").toLowerCase(),
    tlsEmail: option("--tls-email").toLowerCase(),
  };
  const origin = new URL(parsed.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/")
    throw new Error("--origin must be an HTTPS origin without a path");
  if (!/^dev_[a-z0-9_]+$/u.test(parsed.database))
    throw new Error(
      "--database must be lowercase snake_case with a dev_ prefix",
    );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(parsed.ownerEmail))
    throw new Error("--owner-email must be valid");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(parsed.tlsEmail))
    throw new Error("--tls-email must be valid");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parsed.tenantSlug))
    throw new Error("--tenant-slug must be a URL slug");
  return parsed;
}

function parseEnv(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    values.set(match[1] ?? "", value);
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value)
    throw new Error(`${name} is required in the trusted source environment`);
  return safeValue(name, value);
}

function safeValue(name: string, value: string): string {
  if (/[\r\n\0]/u.test(value))
    throw new Error(`${name} must be a single-line value`);
  return value;
}

function inherited(
  values: Map<string, string>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = values.get(name)?.trim();
      return value ? [[name, safeValue(name, value)] as const] : [];
    }),
  );
}

function secret(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}

function base64Key(): string {
  return randomBytes(32).toString("base64");
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function serialize(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${safeValue(name, value)}`)
    .join("\n")}\n`;
}

async function privateFile(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function main(): Promise<void> {
  const input = options();
  await stat(input.source);
  const source = parseEnv(await readFile(input.source, "utf8"));
  try {
    await stat(input.output);
    throw new Error(`Output already exists: ${input.output}`);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  await mkdir(input.output, { recursive: true, mode: 0o700 });
  const config = resolve(input.output, "config");
  await mkdir(config, { mode: 0o700 });

  const flags = {
    ENABLE_REAL_WHATSAPP: source.get("ENABLE_REAL_WHATSAPP") ?? "false",
    ENABLE_REAL_TELEPHONY: source.get("ENABLE_REAL_TELEPHONY") ?? "false",
    ENABLE_REAL_VOICE_PROVIDERS:
      source.get("ENABLE_REAL_VOICE_PROVIDERS") ?? "false",
    ENABLE_WHATSAPP_AI: source.get("ENABLE_WHATSAPP_AI") ?? "false",
    ENABLE_WHATSAPP_AUTO_CALLS:
      source.get("ENABLE_WHATSAPP_AUTO_CALLS") ?? "false",
    ENABLE_REAL_BILLING: source.get("ENABLE_REAL_BILLING") ?? "false",
  };
  for (const [name, value] of Object.entries(flags))
    if (value !== "true" && value !== "false")
      throw new Error(`${name} must be true or false`);

  const whatsappNames = [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_WABA_ID",
    "WHATSAPP_GRAPH_API_VERSION",
  ] as const;
  const llmNames = [
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_REASONING_EFFORT",
    "LLM_MAX_TOKENS",
    "LLM_TEMPERATURE",
    "LLM_REQUEST_TIMEOUT_SECS",
    "LLM_WARMUP",
  ] as const;
  const voiceNames = [
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "SIP_OUTBOUND_TRUNK_ID",
    "SONIOX_API_KEY",
    "SONIOX_STT_MODEL",
    "SONIOX_TTS_MODEL",
    "SONIOX_TTS_VOICE_DEFAULT",
    "SONIOX_ENDPOINT_LATENCY_ADJUSTMENT_LEVEL",
    "SONIOX_ENDPOINT_SENSITIVITY",
    "SONIOX_MAX_ENDPOINT_DELAY_MS",
    "TTS_PROVIDER",
    "TTS_FIRST_CLAUSE",
    "TTS_NIQQUD",
    "TTS_SPEED",
    "TTS_TEXT_AGGREGATION",
    "TURN_START",
    "TURN_END",
    "INTERRUPT_MIN_WORDS",
    "USER_SPEECH_TIMEOUT",
    "USER_IDLE_SECS",
    "VAD_STOP_SECS",
    "VAD_CONFIDENCE",
    "VAD_MIN_VOLUME",
    "AUDIO_IN_FILTER",
    "GENDER_DETECTION_ENABLED",
    "ROOM_PREFIX",
    "BOT_IDENTITY",
    "GOOGLE_CLOUD_PROJECT",
    "VERTEX_LOCATION",
    "VERTEX_LLM_MODEL",
    "VERTEX_THINKING_BUDGET",
  ] as const;

  if (flags.ENABLE_REAL_WHATSAPP === "true")
    for (const name of whatsappNames) required(source, name);
  if (flags.ENABLE_WHATSAPP_AI === "true")
    for (const name of llmNames.slice(0, 4)) required(source, name);
  if (flags.ENABLE_REAL_VOICE_PROVIDERS === "true")
    for (const name of [
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "SONIOX_API_KEY",
    ])
      required(source, name);
  if (flags.ENABLE_REAL_TELEPHONY === "true")
    required(source, "SIP_OUTBOUND_TRUNK_ID");

  const passwords = {
    migrator: secret(),
    web: secret(),
    voice: secret(),
    messaging: secret(),
    owner: secret(32),
  };
  const authTokenPepper = secret();
  const authServiceSecret = secret();
  const credentialEncryptionKey =
    configured(source.get("CREDENTIAL_ENCRYPTION_KEY")) ?? base64Key();
  const fieldCipherKey =
    configured(source.get("FIELD_CIPHER_LOCAL_KEY")) ?? base64Key();
  const blindIndexKey =
    configured(source.get("BLIND_INDEX_KEY")) ?? base64Key();
  const dummyHash = await hashPassword(secret(24));
  const databaseUrl = (role: string, password: string) =>
    `postgresql://${role}:${encodeURIComponent(password)}@postgres:5432/${input.database}`;

  const whatsapp = inherited(source, whatsappNames);
  const llm = inherited(source, llmNames);
  const voice = inherited(source, voiceNames);
  await privateFile(
    resolve(config, "postgres-password.txt"),
    `${passwords.migrator}\n`,
  );
  await privateFile(
    resolve(config, "owner-password.txt"),
    `${passwords.owner}\n`,
  );
  await privateFile(
    resolve(config, "migrator.env"),
    serialize({
      DATABASE_URL: databaseUrl("platform_migrator", passwords.migrator),
      PLATFORM_WEB_PASSWORD: passwords.web,
      PLATFORM_VOICE_PASSWORD: passwords.voice,
      PLATFORM_MESSAGING_PASSWORD: passwords.messaging,
    }),
  );
  await privateFile(
    resolve(config, "bootstrap-owner.env"),
    serialize({
      MIGRATION_DATABASE_URL: databaseUrl(
        "platform_migrator",
        passwords.migrator,
      ),
      BOOTSTRAP_OWNER_EMAIL: input.ownerEmail,
      BOOTSTRAP_TENANT_NAME: input.tenantName,
      BOOTSTRAP_TENANT_SLUG: input.tenantSlug,
    }),
  );
  await privateFile(
    resolve(config, "control-api.env"),
    serialize({
      DATABASE_URL: databaseUrl("platform_web", passwords.web),
      VOICE_DATABASE_URL: databaseUrl("platform_voice", passwords.voice),
      AUTH_SERVICE_SECRET: authServiceSecret,
      ENABLE_REAL_VOICE_PROVIDERS: flags.ENABLE_REAL_VOICE_PROVIDERS,
      ...voice,
      ...llm,
    }),
  );
  await privateFile(
    resolve(config, "web.env"),
    serialize({
      DATABASE_URL: databaseUrl("platform_web", passwords.web),
      AUTH_TOKEN_PEPPER: authTokenPepper,
      AUTH_SERVICE_SECRET: authServiceSecret,
      AUTH_DUMMY_PASSWORD_HASH: dummyHash,
      CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
      FIELD_CIPHER_LOCAL_KEY: fieldCipherKey,
      BLIND_INDEX_KEY: blindIndexKey,
      ...whatsapp,
      ...llm,
      ARTIFACTS_BACKEND: "local",
      ARTIFACTS_LOCAL_ROOT: "/var/lib/oron/objects",
    }),
  );
  await privateFile(
    resolve(config, "messaging-worker.env"),
    serialize({
      MESSAGING_DATABASE_URL: databaseUrl(
        "platform_messaging",
        passwords.messaging,
      ),
      AUTH_SERVICE_SECRET: authServiceSecret,
      FIELD_CIPHER_LOCAL_KEY: fieldCipherKey,
      BLIND_INDEX_KEY: blindIndexKey,
      ...whatsapp,
      ...llm,
      ARTIFACTS_BACKEND: "local",
      ARTIFACTS_LOCAL_ROOT: "/var/lib/oron/objects",
    }),
  );
  await privateFile(
    resolve(config, "dispatcher.env"),
    serialize({
      VOICE_DATABASE_URL: databaseUrl("platform_voice", passwords.voice),
      AUTH_SERVICE_SECRET: authServiceSecret,
      FIELD_CIPHER_LOCAL_KEY: fieldCipherKey,
      BLIND_INDEX_KEY: blindIndexKey,
      ...voice,
      ...llm,
      ARTIFACTS_BACKEND: "local",
      ARTIFACTS_LOCAL_ROOT: "/var/lib/oron/objects",
    }),
  );
  await privateFile(
    resolve(input.output, "deployment.env"),
    serialize({
      DEPLOYMENT_CONFIG_DIR: "/opt/oron-dev/shared/config",
      DEPLOYMENT_DATA_DIR: "/opt/oron-dev/shared/data",
      DEPLOYMENT_DATABASE_NAME: input.database,
      PLATFORM_ORIGIN: input.origin,
      TLS_CONTACT_EMAIL: input.tlsEmail,
      ...flags,
    }),
  );
  await privateFile(
    resolve(input.output, "generated-credentials.txt"),
    serialize({
      BOOTSTRAP_OWNER_EMAIL: input.ownerEmail,
      BOOTSTRAP_OWNER_PASSWORD: passwords.owner,
      DATABASE_NAME: input.database,
      PLATFORM_MIGRATOR_USERNAME: "platform_migrator",
      PLATFORM_MIGRATOR_PASSWORD: passwords.migrator,
      PLATFORM_WEB_USERNAME: "platform_web",
      PLATFORM_WEB_PASSWORD: passwords.web,
      PLATFORM_VOICE_USERNAME: "platform_voice",
      PLATFORM_VOICE_PASSWORD: passwords.voice,
      PLATFORM_MESSAGING_USERNAME: "platform_messaging",
      PLATFORM_MESSAGING_PASSWORD: passwords.messaging,
    }),
  );
  console.log(`Rendered private deployment configuration at ${input.output}`);
  console.log(
    "Credential values were written to generated-credentials.txt and were not printed",
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Configuration rendering failed",
  );
  process.exitCode = 1;
});
