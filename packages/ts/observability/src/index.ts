import pino, { type DestinationStream, type Logger } from "pino";

const sensitiveKey =
  /(?:authorization|cookie|credential|database.?url|key|password|secret|token)/iu;

export interface LoggerOptions {
  readonly environment: string;
  readonly level?: pino.LevelWithSilent;
  readonly service: string;
}

export function redactSensitiveValues(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item !== "object" || item instanceof Date)
      return item;
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const output: unknown[] = [];
      seen.set(item, output);
      for (const entry of item) output.push(visit(entry));
      return output;
    }
    const output: Record<string, unknown> = {};
    seen.set(item, output);
    const fields = item instanceof Error ? pino.stdSerializers.err(item) : item;
    for (const [key, entry] of Object.entries(fields)) {
      Object.defineProperty(output, key, {
        value: sensitiveKey.test(key) ? "[REDACTED]" : visit(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  };
  return visit(value);
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
      formatters: {
        log: (record) =>
          redactSensitiveValues(record) as Record<string, unknown>,
      },
      serializers: { err: redactSensitiveValues },
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
