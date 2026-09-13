import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalNumericIdentifier = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().regex(/^\d+$/u).optional(),
);

const optionalProviderUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .url()
    .refine(
      (value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      },
      {
        message:
          "must be an HTTP(S) URL without credentials, query or fragment",
      },
    )
    .optional(),
);

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
  MESSAGING_DATABASE_URL: z
    .string()
    .trim()
    .refine((value) => /^postgres(?:ql)?:\/\//u.test(value), {
      message: "must be a PostgreSQL URL",
    })
    .optional(),
  CONTROL_API_URL: z.url().default("http://127.0.0.1:8000"),
  DISPATCHER_URL: optionalProviderUrl.default("http://127.0.0.1:8082"),
  PUBLIC_SITE_URL: z
    .url()
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/"
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "must be an HTTP(S) origin without credentials, path, query or fragment",
      },
    )
    .default("http://127.0.0.1:3000"),
  LOG_LEVEL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["trace", "debug", "info", "warn", "error", "fatal"]))
    .default("info"),
  ENABLE_REAL_TELEPHONY: booleanFlag,
  ENABLE_REAL_VOICE_PROVIDERS: booleanFlag,
  ENABLE_REAL_WHATSAPP: booleanFlag,
  ENABLE_WHATSAPP_AI: booleanFlag,
  ENABLE_WHATSAPP_AUTO_CALLS: booleanFlag,
  ENABLE_REAL_BILLING: booleanFlag,
  LIVEKIT_API_SECRET: optionalSecret,
  WHATSAPP_ACCESS_TOKEN: optionalSecret,
  WHATSAPP_APP_SECRET: optionalSecret,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalSecret,
  WHATSAPP_PHONE_NUMBER_ID: optionalNumericIdentifier,
  WHATSAPP_WABA_ID: optionalNumericIdentifier,
  WHATSAPP_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.0$/u)
    .optional(),
  LLM_PROVIDER: z.enum(["vertex", "openai-compat"]).default("vertex"),
  LLM_API_KEY: optionalSecret,
  LLM_MODEL: optionalText,
  LLM_BASE_URL: optionalProviderUrl,
  CREDENTIAL_ENCRYPTION_KEY: optionalSecret,
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  AUTH_TOKEN_PEPPER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  AUTH_SERVICE_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  AUTH_DUMMY_PASSWORD_HASH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().startsWith("$argon2id$").optional(),
  ),
});

export class ConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export interface LoadConfigOptions {
  readonly requireDatabase?: boolean;
  readonly requireMessagingDatabase?: boolean;
  readonly requireAuth?: boolean;
  readonly requireWhatsApp?: boolean;
  readonly service?: string;
}

export interface PlatformConfig {
  readonly publicSiteUrl?: string;
  readonly environment: "development" | "test" | "production";
  readonly service: string;
  readonly databaseUrl: string | undefined;
  readonly messagingDatabaseUrl: string | undefined;
  readonly controlApiUrl: string;
  readonly dispatcherUrl: string;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly enableRealTelephony: boolean;
  readonly enableRealVoiceProviders: boolean;
  readonly enableRealWhatsApp: boolean;
  readonly enableWhatsAppAi: boolean;
  readonly enableWhatsAppAutoCalls: boolean;
  readonly enableRealBilling: boolean;
  readonly llm: {
    readonly provider: "vertex" | "openai-compat";
    readonly model: string | undefined;
    readonly baseUrl: string | undefined;
  };
  readonly whatsApp: {
    readonly graphApiVersion: string | undefined;
    readonly phoneNumberId: string | undefined;
    readonly wabaId: string | undefined;
  };
  readonly secrets: {
    readonly livekitApiSecret: string | undefined;
    readonly whatsappAccessToken: string | undefined;
    readonly whatsappAppSecret: string | undefined;
    readonly whatsappWebhookVerifyToken: string | undefined;
    readonly llmApiKey: string | undefined;
    readonly credentialEncryptionKey: string | undefined;
    readonly stripeSecretKey: string | undefined;
    readonly stripeWebhookSecret: string | undefined;
    readonly authTokenPepper: string | undefined;
    readonly authServiceSecret: string | undefined;
    readonly authDummyPasswordHash: string | undefined;
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

  if (
    options.requireMessagingDatabase === true &&
    result.data.MESSAGING_DATABASE_URL === undefined
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: MESSAGING_DATABASE_URL is required for this service",
    );
  }

  if (
    options.requireWhatsApp === true &&
    result.data.ENABLE_REAL_WHATSAPP &&
    (result.data.WHATSAPP_ACCESS_TOKEN === undefined ||
      result.data.WHATSAPP_APP_SECRET === undefined ||
      result.data.WHATSAPP_APP_SECRET.length < 16 ||
      result.data.WHATSAPP_WEBHOOK_VERIFY_TOKEN === undefined ||
      result.data.WHATSAPP_WEBHOOK_VERIFY_TOKEN.length < 16 ||
      result.data.WHATSAPP_PHONE_NUMBER_ID === undefined ||
      result.data.WHATSAPP_WABA_ID === undefined ||
      result.data.WHATSAPP_GRAPH_API_VERSION === undefined)
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: real WhatsApp requires access token, app secret, webhook verify token, phone number ID, WABA ID, and Graph API version",
    );
  }

  if (
    options.requireAuth === true &&
    (result.data.AUTH_TOKEN_PEPPER === undefined ||
      result.data.AUTH_SERVICE_SECRET === undefined ||
      result.data.AUTH_DUMMY_PASSWORD_HASH === undefined)
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: AUTH_TOKEN_PEPPER, AUTH_SERVICE_SECRET, and AUTH_DUMMY_PASSWORD_HASH are required for authentication",
    );
  }

  if (
    result.data.ENABLE_WHATSAPP_AI &&
    (result.data.LLM_PROVIDER !== "openai-compat" ||
      result.data.LLM_API_KEY === undefined ||
      result.data.LLM_BASE_URL === undefined ||
      result.data.LLM_MODEL === undefined)
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: WhatsApp AI requires LLM_PROVIDER=openai-compat plus LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL",
    );
  }

  if (
    result.data.ENABLE_WHATSAPP_AUTO_CALLS &&
    (!result.data.ENABLE_WHATSAPP_AI ||
      !result.data.ENABLE_REAL_WHATSAPP ||
      !result.data.ENABLE_REAL_TELEPHONY ||
      !result.data.ENABLE_REAL_VOICE_PROVIDERS ||
      result.data.AUTH_SERVICE_SECRET === undefined)
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: WhatsApp automatic calls require WhatsApp AI, real WhatsApp, both real voice flags, and AUTH_SERVICE_SECRET",
    );
  }

  if (
    result.data.ENABLE_REAL_BILLING &&
    (result.data.STRIPE_SECRET_KEY === undefined ||
      result.data.STRIPE_WEBHOOK_SECRET === undefined)
  ) {
    throw new ConfigurationError(
      "Invalid platform configuration: real billing requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET",
    );
  }

  return {
    environment: result.data.PLATFORM_ENV,
    service:
      options.service ?? result.data.PLATFORM_SERVICE ?? "unknown-service",
    databaseUrl: result.data.DATABASE_URL,
    messagingDatabaseUrl: result.data.MESSAGING_DATABASE_URL,
    controlApiUrl: result.data.CONTROL_API_URL,
    dispatcherUrl: result.data.DISPATCHER_URL,
    publicSiteUrl: result.data.PUBLIC_SITE_URL,
    logLevel: result.data.LOG_LEVEL,
    enableRealTelephony: result.data.ENABLE_REAL_TELEPHONY,
    enableRealVoiceProviders: result.data.ENABLE_REAL_VOICE_PROVIDERS,
    enableRealWhatsApp: result.data.ENABLE_REAL_WHATSAPP,
    enableWhatsAppAi: result.data.ENABLE_WHATSAPP_AI,
    enableWhatsAppAutoCalls: result.data.ENABLE_WHATSAPP_AUTO_CALLS,
    enableRealBilling: result.data.ENABLE_REAL_BILLING,
    llm: {
      provider: result.data.LLM_PROVIDER,
      model: result.data.LLM_MODEL,
      baseUrl: result.data.LLM_BASE_URL,
    },
    whatsApp: {
      graphApiVersion: result.data.WHATSAPP_GRAPH_API_VERSION,
      phoneNumberId: result.data.WHATSAPP_PHONE_NUMBER_ID,
      wabaId: result.data.WHATSAPP_WABA_ID,
    },
    secrets: {
      livekitApiSecret: result.data.LIVEKIT_API_SECRET,
      whatsappAccessToken: result.data.WHATSAPP_ACCESS_TOKEN,
      whatsappAppSecret: result.data.WHATSAPP_APP_SECRET,
      whatsappWebhookVerifyToken: result.data.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      llmApiKey: result.data.LLM_API_KEY,
      credentialEncryptionKey: result.data.CREDENTIAL_ENCRYPTION_KEY,
      stripeSecretKey: result.data.STRIPE_SECRET_KEY,
      stripeWebhookSecret: result.data.STRIPE_WEBHOOK_SECRET,
      authTokenPepper: result.data.AUTH_TOKEN_PEPPER,
      authServiceSecret: result.data.AUTH_SERVICE_SECRET,
      authDummyPasswordHash: result.data.AUTH_DUMMY_PASSWORD_HASH,
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
    messagingDatabaseUrl:
      config.messagingDatabaseUrl === undefined ? "unset" : "[REDACTED]",
    controlApiUrl: config.controlApiUrl,
    dispatcherUrl: config.dispatcherUrl,
    logLevel: config.logLevel,
    enableRealTelephony: config.enableRealTelephony,
    enableRealVoiceProviders: config.enableRealVoiceProviders,
    enableRealWhatsApp: config.enableRealWhatsApp,
    enableWhatsAppAi: config.enableWhatsAppAi,
    enableWhatsAppAutoCalls: config.enableWhatsAppAutoCalls,
    enableRealBilling: config.enableRealBilling,
    livekitApiSecret:
      config.secrets.livekitApiSecret === undefined ? "unset" : "[REDACTED]",
    whatsappAccessToken:
      config.secrets.whatsappAccessToken === undefined ? "unset" : "[REDACTED]",
    whatsappAppSecret:
      config.secrets.whatsappAppSecret === undefined ? "unset" : "[REDACTED]",
    whatsappWebhookVerifyToken:
      config.secrets.whatsappWebhookVerifyToken === undefined
        ? "unset"
        : "[REDACTED]",
    whatsappGraphApiVersion: config.whatsApp.graphApiVersion ?? "unset",
    whatsappPhoneNumberId:
      config.whatsApp.phoneNumberId === undefined ? "unset" : "configured",
    whatsappWabaId:
      config.whatsApp.wabaId === undefined ? "unset" : "configured",
    llmApiKey: config.secrets.llmApiKey === undefined ? "unset" : "[REDACTED]",
    llmProvider: config.llm.provider,
    llmBaseUrl: config.llm.baseUrl === undefined ? "unset" : "configured",
    llmModel: config.llm.model ?? "unset",
    credentialEncryptionKey:
      config.secrets.credentialEncryptionKey === undefined
        ? "unset"
        : "[REDACTED]",
    stripeSecretKey:
      config.secrets.stripeSecretKey === undefined ? "unset" : "[REDACTED]",
    stripeWebhookSecret:
      config.secrets.stripeWebhookSecret === undefined ? "unset" : "[REDACTED]",
    authTokenPepper:
      config.secrets.authTokenPepper === undefined ? "unset" : "[REDACTED]",
    authServiceSecret:
      config.secrets.authServiceSecret === undefined ? "unset" : "[REDACTED]",
    authDummyPasswordHash:
      config.secrets.authDummyPasswordHash === undefined
        ? "unset"
        : "[REDACTED]",
  };
}
