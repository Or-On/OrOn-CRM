import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const sourceSchema = z.object({
  PLATFORM_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PLATFORM_SERVICE: z.string().trim().min(1).optional(),
  DATABASE_URL: z
    .string()
    .trim()
    .refine((value) => /^postgres(?:ql)?:\/\//u.test(value), {
      message: "must be a PostgreSQL URL",
    })
    .optional(),
  CONTROL_API_URL: z.url().default("http://127.0.0.1:8000"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  ENABLE_REAL_TELEPHONY: booleanFlag,
  ENABLE_REAL_WHATSAPP: booleanFlag,
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  AI_API_KEY: z.string().min(1).optional(),
});

export class ConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export interface LoadConfigOptions {
  readonly requireDatabase?: boolean;
  readonly service?: string;
}

export interface PlatformConfig {
  readonly environment: "development" | "test" | "production";
  readonly service: string;
  readonly databaseUrl: string | undefined;
  readonly controlApiUrl: string;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly enableRealTelephony: boolean;
  readonly enableRealWhatsApp: boolean;
  readonly secrets: {
    readonly livekitApiSecret: string | undefined;
    readonly whatsappAccessToken: string | undefined;
    readonly aiApiKey: string | undefined;
  };
}

export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadConfigOptions = {},
): PlatformConfig {
  const result = sourceSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      )
      .join("; ");
    throw new ConfigurationError(`Invalid platform configuration: ${details}`);
  }

  if (
    options.requireDatabase === true &&
    result.data.DATABASE_URL === undefined
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: DATABASE_URL is required for this service",
    );
  }

  return {
    environment: result.data.PLATFORM_ENV,
    service:
      options.service ?? result.data.PLATFORM_SERVICE ?? "unknown-service",
    databaseUrl: result.data.DATABASE_URL,
    controlApiUrl: result.data.CONTROL_API_URL,
    logLevel: result.data.LOG_LEVEL,
    enableRealTelephony: result.data.ENABLE_REAL_TELEPHONY,
    enableRealWhatsApp: result.data.ENABLE_REAL_WHATSAPP,
    secrets: {
      livekitApiSecret: result.data.LIVEKIT_API_SECRET,
      whatsappAccessToken: result.data.WHATSAPP_ACCESS_TOKEN,
      aiApiKey: result.data.AI_API_KEY,
    },
  };
}

export function configDiagnostics(
  config: PlatformConfig,
): Readonly<Record<string, unknown>> {
  return {
    environment: config.environment,
    service: config.service,
    databaseUrl: config.databaseUrl === undefined ? "unset" : "[REDACTED]",
    controlApiUrl: config.controlApiUrl,
    logLevel: config.logLevel,
    enableRealTelephony: config.enableRealTelephony,
    enableRealWhatsApp: config.enableRealWhatsApp,
    livekitApiSecret:
      config.secrets.livekitApiSecret === undefined ? "unset" : "[REDACTED]",
    whatsappAccessToken:
      config.secrets.whatsappAccessToken === undefined ? "unset" : "[REDACTED]",
    aiApiKey: config.secrets.aiApiKey === undefined ? "unset" : "[REDACTED]",
  };
}
