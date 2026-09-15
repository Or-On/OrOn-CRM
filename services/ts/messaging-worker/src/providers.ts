import { createHash } from "node:crypto";
import type { WhatsAppSendDiagnostic } from "@or-on/crm";
import { metaDiagnostic } from "./meta-diagnostics.js";

export type WhatsAppDelivery =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "template";
      readonly templateName: string;
      readonly language: string;
      readonly parameters: readonly string[];
    };

export interface WhatsAppSendRequest {
  readonly beforeAttempt?: () => Promise<void>;
  readonly senderPhoneNumberId?: string;
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly delivery: WhatsAppDelivery;
}

export interface WhatsAppSendResult {
  readonly messageId: string;
}

export interface WhatsAppMediaDownloadRequest {
  readonly mediaId: string;
  readonly expectedMimeType?: string;
  readonly expectedSha256?: string;
  readonly beforeAttempt?: () => Promise<void>;
}

export interface WhatsAppMediaDownloadResult {
  readonly bytes: Uint8Array;
  readonly contentType:
    "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  readonly sha256: string;
}

export interface WhatsAppProvider {
  readonly name: "simulator" | "meta";
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
  downloadMedia?(
    request: WhatsAppMediaDownloadRequest,
  ): Promise<WhatsAppMediaDownloadResult>;
}

export class WhatsAppProviderError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly diagnostic?: WhatsAppSendDiagnostic,
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

  public async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
    validateWhatsAppRequest(request);
    await request.beforeAttempt?.();

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

export class MetaWhatsAppProvider implements WhatsAppProvider {
  public readonly name = "meta" as const;
  readonly #options: MetaWhatsAppProviderOptions;

  public constructor(options: MetaWhatsAppProviderOptions) {
    this.#options = options;
  }

  public async downloadMedia(
    request: WhatsAppMediaDownloadRequest,
  ): Promise<WhatsAppMediaDownloadResult> {
    if (!this.#options.enabled)
      throw new WhatsAppProviderError("provider_disabled", false);
    const { accessToken, graphApiVersion: version } = this.#options;
    if (
      accessToken === undefined ||
      version === undefined ||
      !graphVersion.test(version) ||
      !resourceId.test(request.mediaId)
    )
      throw new WhatsAppProviderError("provider_not_configured", false);
    const execute = this.#options.fetch ?? fetch;
    const requestWithTimeout = async (url: string): Promise<Response> => {
      await request.beforeAttempt?.();
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#options.timeoutMs ?? 8_000,
      );
      try {
        return await execute(url, {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
      } catch {
        throw new WhatsAppProviderError("media_transport_error", true);
      } finally {
        clearTimeout(timeout);
      }
    };
    const metadataResponse = await requestWithTimeout(
      `https://graph.facebook.com/${version}/${request.mediaId}`,
    );
    if (!metadataResponse.ok)
      throw new WhatsAppProviderError(
        `media_metadata_http_${String(metadataResponse.status)}`,
        metadataResponse.status === 429 || metadataResponse.status >= 500,
        metadataResponse.status,
      );
    const metadata = (await metadataResponse.json().catch(() => undefined)) as
      Readonly<Record<string, unknown>> | undefined;
    const mediaUrl =
      typeof metadata?.url === "string" ? metadata.url : undefined;
    if (mediaUrl === undefined)
      throw new WhatsAppProviderError("media_metadata_invalid", false);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(mediaUrl);
    } catch {
      throw new WhatsAppProviderError("media_url_invalid", false);
    }
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username ||
      parsedUrl.password ||
      !(
        parsedUrl.hostname === "facebook.com" ||
        parsedUrl.hostname.endsWith(".facebook.com") ||
        parsedUrl.hostname === "fbsbx.com" ||
        parsedUrl.hostname.endsWith(".fbsbx.com")
      )
    )
      throw new WhatsAppProviderError("media_url_invalid", false);
    const mediaResponse = await requestWithTimeout(parsedUrl.toString());
    if (!mediaResponse.ok)
      throw new WhatsAppProviderError(
        `media_download_http_${String(mediaResponse.status)}`,
        mediaResponse.status === 429 || mediaResponse.status >= 500,
        mediaResponse.status,
      );
    const declared =
      mediaResponse.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.toLowerCase() ??
      (typeof metadata?.mime_type === "string"
        ? metadata.mime_type.toLowerCase()
        : "");
    if (
      declared !== "image/jpeg" &&
      declared !== "image/png" &&
      declared !== "image/webp" &&
      declared !== "application/pdf"
    )
      throw new WhatsAppProviderError("media_content_type_unsupported", false);
    if (
      request.expectedMimeType !== undefined &&
      request.expectedMimeType.toLowerCase() !== declared
    )
      throw new WhatsAppProviderError("media_content_type_mismatch", false);
    const contentLength = Number(mediaResponse.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 20 * 1024 * 1024)
      throw new WhatsAppProviderError("media_too_large", false);
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024)
      throw new WhatsAppProviderError("media_too_large", false);
    const digest = createHash("sha256").update(bytes).digest();
    const sha256 = digest.toString("hex");
    const expected = request.expectedSha256?.trim();
    const expectedMatches =
      expected === undefined ||
      (/^[0-9a-f]{64}$/iu.test(expected)
        ? expected.toLowerCase() === sha256
        : /^[A-Za-z0-9+/]{43}=?$/u.test(expected) &&
          expected.replace(/=+$/u, "") ===
            digest.toString("base64").replace(/=+$/u, ""));
    if (!expectedMatches)
      throw new WhatsAppProviderError("media_checksum_mismatch", false);
    return { bytes, contentType: declared, sha256 };
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

    if (
      request.senderPhoneNumberId !== undefined &&
      request.senderPhoneNumberId !== phoneNumberId
    )
      throw new WhatsAppProviderError("sender_configuration_changed", false);
    const execute = this.#options.fetch ?? fetch;
    const maxAttempts = Math.min(
      Math.max(this.#options.maxAttempts ?? 3, 1),
      5,
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Authorization is re-read after every rate-limit delay. Refusal occurs
      // before HTTP and is not an ambiguous provider outcome or a retry signal.
      await request.beforeAttempt?.();
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
          const record = payload as
            | {
                readonly messages?: readonly { readonly id?: unknown }[];
              }
            | null
            | undefined;
          const id = record?.messages?.[0]?.id;
          if (typeof id !== "string" || id.length === 0)
            throw new WhatsAppProviderError(
              "delivery_outcome_unknown",
              false,
              response.status,
            );
          return { messageId: id };
        }
        // Only explicit rate-limit rejection is safe to repeat. A gateway/server
        // error may have happened after provider acceptance of a POST.
        const retryable = response.status === 429;
        if (response.status >= 500)
          throw new WhatsAppProviderError(
            "delivery_outcome_unknown",
            false,
            response.status,
          );
        if (!retryable || attempt === maxAttempts) {
          const diagnostic = metaDiagnostic(
            payload,
            response.status,
            retryable,
          );
          throw new WhatsAppProviderError(
            diagnostic.metaCode === null
              ? "meta_http_error"
              : `meta_${String(diagnostic.metaCode)}`,
            retryable,
            response.status,
            diagnostic,
          );
        }
      } catch (error) {
        if (error instanceof WhatsAppProviderError) throw error;
        // Meta does not guarantee deduplication of our local idempotency key.
        // Never automatically replay an ambiguous network/timeout outcome.
        throw new WhatsAppProviderError("delivery_outcome_unknown", false);
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
