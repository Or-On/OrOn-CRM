import pino, { type DestinationStream, type Logger } from "pino";

const sensitiveKey =
  /(?:authorization|cookie|credential|database.?url|key|password|secret|token)/iu;

export interface LoggerOptions {
  readonly environment: string;
  readonly level?: pino.LevelWithSilent;
  readonly service: string;
}

export function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redactSensitiveValues(item),
      ]),
    );
  }

  return value;
}

export function createLogger(
  options: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      base: { service: options.service, environment: options.environment },
      level: options.level ?? "info",
      messageKey: "message",
      redact: {
        paths: [
          "*.authorization",
          "*.cookie",
          "*.credentials",
          "*.databaseUrl",
          "*.password",
          "*.privateKey",
          "*.secret",
          "*.token",
        ],
        censor: "[REDACTED]",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
