import { createHash } from "node:crypto";

export type WhatsAppDelivery =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "template";
      readonly templateName: string;
      readonly language: string;
      readonly parameters: readonly string[];
    };

export interface WhatsAppSendRequest {
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly delivery: WhatsAppDelivery;
}

export interface WhatsAppSendResult {
  readonly messageId: string;
}

export interface WhatsAppProvider {
  readonly name: "simulator" | "meta";
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
}

export class WhatsAppProviderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(`WhatsApp provider request failed (${code})`);
    this.name = "WhatsAppProviderError";
  }
}

const e164 = /^\+[1-9][0-9]{7,14}$/u;
const graphVersion = /^v\d+\.0$/u;
const resourceId = /^\d+$/u;
const templateName = /^[a-z0-9_]{1,512}$/u;
const templateLanguage = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;

export function validateWhatsAppRequest(request: WhatsAppSendRequest): void {
  if (!e164.test(request.recipient))
    throw new TypeError("recipient must be strict E.164");
  if (
    request.idempotencyKey.trim().length < 8 ||
    request.idempotencyKey.length > 200
  )
    throw new TypeError("idempotency key must contain 8-200 characters");
  if (request.delivery.kind === "text") {
    const text = request.delivery.text.trim();
    if (text.length === 0 || text.length > 4096)
      throw new TypeError("text must contain 1-4096 characters");
    return;
  }
  if (!templateName.test(request.delivery.templateName))
    throw new TypeError("invalid approved template name");
  if (!templateLanguage.test(request.delivery.language))
    throw new TypeError("invalid template language");
  if (
    request.delivery.parameters.length > 100 ||
    request.delivery.parameters.some((value) => value.length > 1024)
  )
    throw new TypeError("invalid template parameters");
}

export class SimulatorWhatsAppProvider implements WhatsAppProvider {
  public readonly name = "simulator" as const;

  public send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
    validateWhatsAppRequest(request);
    const digest = createHash("sha256")
      .update(`simulator:${request.idempotencyKey}`)
      .digest("hex");
    return Promise.resolve({ messageId: `sim_${digest.slice(0, 24)}` });
  }
}

export interface MetaWhatsAppProviderOptions {
  readonly accessToken: string | undefined;
  readonly enabled: boolean;
  readonly fetch?: typeof fetch;
  readonly graphApiVersion: string | undefined;
  readonly maxAttempts?: number;
  readonly phoneNumberId: string | undefined;
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function metaPayload(delivery: WhatsAppDelivery, recipient: string): object {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient.slice(1),
  };
  if (delivery.kind === "text") {
    return {
      ...base,
      type: "text",
      text: { preview_url: false, body: delivery.text.trim() },
    };
  }
  const components =
    delivery.parameters.length === 0
      ? undefined
      : [
          {
            type: "body",
            parameters: delivery.parameters.map((text) => ({
              type: "text",
              text,
            })),
          },
        ];
  return {
    ...base,
    type: "template",
    template: {
      name: delivery.templateName,
      language: { code: delivery.language },
      ...(components === undefined ? {} : { components }),
    },
  };
}

function responseCode(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || !("error" in payload))
    return "meta_http_error";
  const error = payload.error;
  if (error === null || typeof error !== "object" || !("code" in error))
    return "meta_http_error";
  const code = error.code;
  return typeof code === "number" || typeof code === "string"
    ? `meta_${String(code)}`
    : "meta_http_error";
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  public readonly name = "meta" as const;
  readonly #options: MetaWhatsAppProviderOptions;

  public constructor(options: MetaWhatsAppProviderOptions) {
    this.#options = options;
  }

  public async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
    // Lowest-boundary kill switch: callers cannot bypass this check.
    if (!this.#options.enabled)
      throw new WhatsAppProviderError("provider_disabled", false);
    const {
      accessToken,
      graphApiVersion: version,
      phoneNumberId,
    } = this.#options;
    if (
      accessToken === undefined ||
      version === undefined ||
      phoneNumberId === undefined ||
      !graphVersion.test(version) ||
      !resourceId.test(phoneNumberId)
    )
      throw new WhatsAppProviderError("provider_not_configured", false);
    validateWhatsAppRequest(request);

    const execute = this.#options.fetch ?? fetch;
    const maxAttempts = Math.min(
      Math.max(this.#options.maxAttempts ?? 3, 1),
      5,
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#options.timeoutMs ?? 8000,
      );
      try {
        const response = await execute(
          `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(
              metaPayload(request.delivery, request.recipient),
            ),
            signal: controller.signal,
          },
        );
        const payload = (await response
          .json()
          .catch(() => undefined)) as unknown;
        if (response.ok) {
          const record = payload as {
            readonly messages?: readonly { readonly id?: unknown }[];
          };
          const id = record.messages?.[0]?.id;
          if (typeof id !== "string" || id.length === 0)
            throw new WhatsAppProviderError(
              "invalid_meta_response",
              false,
              response.status,
            );
          return { messageId: id };
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === maxAttempts)
          throw new WhatsAppProviderError(
            responseCode(payload),
            retryable,
            response.status,
          );
      } catch (error) {
        if (error instanceof WhatsAppProviderError) throw error;
        if (attempt === maxAttempts) {
          throw new WhatsAppProviderError(
            error instanceof DOMException && error.name === "AbortError"
              ? "timeout"
              : "network_error",
            true,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
      const jitter = (this.#options.random ?? Math.random)() * 100;
      const delay = Math.min(2000, 200 * 2 ** (attempt - 1) + jitter);
      await (
        this.#options.wait ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(delay);
    }
    throw new WhatsAppProviderError("retry_exhausted", true);
  }
}
