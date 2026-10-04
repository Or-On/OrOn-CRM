import { createHash } from "node:crypto";
import type { WhatsAppSendDiagnostic } from "@or-on/crm";
import { metaDiagnostic } from "./meta-diagnostics.js";

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export type WhatsAppDelivery =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "template";
      readonly templateName: string;
      readonly language: string;
      readonly parameters: readonly string[];
      readonly quickReplies?: readonly {
        readonly index: number;
        readonly payload: string;
      }[];
    };

export interface WhatsAppSendRequest {
  /** Trusted worker observer: called only after credentials, immediately before POST. */
  readonly onAttemptStarted?: () => void;
  readonly maximumAttempts?: 1;
  readonly accessTokenForAttempt?: () => Promise<string | undefined>;
  readonly beforeAttempt?: () => Promise<void>;
  readonly senderPhoneNumberId?: string;
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly delivery: WhatsAppDelivery;
}

export interface WhatsAppSendResult {
  readonly messageId: string;
}

export interface WhatsAppTemplateVerificationRequest {
  readonly senderPhoneNumberId: string;
  readonly wabaId: string;
  readonly graphApiVersion: string;
  readonly templateName: string;
  readonly language: string;
  readonly buttonIndices: readonly number[];
  readonly buttonTexts: readonly string[];
  readonly beforeAttempt: () => Promise<void>;
  readonly accessTokenForAttempt: () => Promise<string | undefined>;
}

/** Server-resolved inbound message and account; guard rechecks AI ownership. */
export interface WhatsAppInboundAcknowledgement {
  readonly accessTokenForAttempt?: () => Promise<string | undefined>;
  readonly senderPhoneNumberId: string;
  readonly providerMessageId: string;
  readonly beforeAttempt: () => Promise<void>;
}

export interface WhatsAppMediaDownloadRequest {
  readonly accessTokenForAttempt?: () => Promise<string | undefined>;
  readonly mediaId: string;
  readonly senderPhoneNumberId?: string;
  readonly expectedMimeType?: string;
  readonly expectedSha256?: string;
  readonly beforeAttempt?: () => Promise<void>;
}

export interface WhatsAppMediaDownloadResult {
  readonly bytes: Uint8Array;
  readonly contentType:
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "application/pdf"
    | "video/mp4"
    | "audio/ogg"
    | "audio/wav";
  readonly sha256: string;
}

export interface WhatsAppProvider {
  readonly name: "simulator" | "meta";
  send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult>;
  verifyTemplate?(
    request: WhatsAppTemplateVerificationRequest,
  ): Promise<boolean>;
  acknowledgeInbound?(request: WhatsAppInboundAcknowledgement): Promise<void>;
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
    public readonly retryAfterMs?: number,
  ) {
    super(`WhatsApp provider request failed (${code})`);
    this.name = "WhatsAppProviderError";
  }
}

const e164 = /^\+[1-9][0-9]{7,14}$/u;
const graphVersion = /^v\d+\.0$/u;
async function boundedMediaBody(
  response: Response,
  maximum: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (response.body === null)
    throw new WhatsAppProviderError("media_empty_body", false);
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WhatsAppProviderError("media_body_timeout", true)),
      timeoutMs,
    );
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum)
        throw new WhatsAppProviderError("media_too_large", false);
      chunks.push(chunk.value);
    }
    if (length === 0)
      throw new WhatsAppProviderError("media_empty_body", false);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
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
  const replies = request.delivery.quickReplies ?? [];
  if (
    replies.length > 10 ||
    new Set(replies.map((reply) => reply.index)).size !== replies.length ||
    replies.some(
      (reply) =>
        !Number.isInteger(reply.index) ||
        reply.index < 0 ||
        reply.index > 9 ||
        reply.payload.trim().length === 0 ||
        Buffer.byteLength(reply.payload, "utf8") > 256 ||
        hasControlCharacters(reply.payload),
    )
  )
    throw new TypeError("invalid template quick replies");
}

export class SimulatorWhatsAppProvider implements WhatsAppProvider {
  public readonly name = "simulator" as const;

  public async acknowledgeInbound(
    request: WhatsAppInboundAcknowledgement,
  ): Promise<void> {
    await request.beforeAttempt();
  }

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
  const bodyComponents =
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
  const components = [
    ...(bodyComponents ?? []),
    ...(delivery.quickReplies ?? []).map((reply) => ({
      type: "button",
      sub_type: "quick_reply",
      index: String(reply.index),
      parameters: [{ type: "payload", payload: reply.payload }],
    })),
  ];
  return {
    ...base,
    type: "template",
    template: {
      name: delivery.templateName,
      language: { code: delivery.language },
      ...(components.length === 0 ? {} : { components }),
    },
  };
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  public readonly name = "meta" as const;
  readonly #options: MetaWhatsAppProviderOptions;

  public constructor(options: MetaWhatsAppProviderOptions) {
    this.#options = options;
  }

  public async verifyTemplate(
    request: WhatsAppTemplateVerificationRequest,
  ): Promise<boolean> {
    if (!this.#options.enabled)
      throw new WhatsAppProviderError("provider_disabled", false);
    const version = this.#options.graphApiVersion;
    if (
      version === undefined ||
      version !== request.graphApiVersion ||
      !graphVersion.test(version) ||
      !resourceId.test(request.wabaId) ||
      request.senderPhoneNumberId !== this.#options.phoneNumberId ||
      !templateName.test(request.templateName) ||
      !templateLanguage.test(request.language) ||
      request.buttonIndices.length !== 2 ||
      request.buttonTexts.length !== 2 ||
      request.buttonTexts.some(
        (text) =>
          text.trim().length === 0 || Buffer.byteLength(text, "utf8") > 256,
      ) ||
      new Set(request.buttonIndices).size !== 2 ||
      request.buttonIndices.some(
        (index) => !Number.isInteger(index) || index < 0 || index > 9,
      )
    )
      throw new WhatsAppProviderError("template_configuration_invalid", false);
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      await request.beforeAttempt();
      const token =
        (await request.accessTokenForAttempt()) ?? this.#options.accessToken;
      if (!token)
        throw new WhatsAppProviderError(
          "channel_credential_unavailable",
          false,
        );
      const url = new URL(
        `https://graph.facebook.com/${version}/${request.wabaId}/message_templates`,
      );
      url.searchParams.set("name", request.templateName);
      url.searchParams.set("fields", "name,language,status,components");
      url.searchParams.set("limit", "100");
      if (cursor !== undefined) url.searchParams.set("after", cursor);
      const response = await (this.#options.fetch ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 8000),
      });
      if (!response.ok)
        throw new WhatsAppProviderError(
          "template_catalog_unavailable",
          response.status === 429 || response.status >= 500,
          response.status,
        );
      const body: unknown = JSON.parse(
        Buffer.from(
          await boundedMediaBody(
            response,
            256 * 1024,
            this.#options.timeoutMs ?? 8000,
          ),
        ).toString("utf8"),
      );
      if (
        typeof body !== "object" ||
        body === null ||
        !("data" in body) ||
        !Array.isArray(body.data)
      )
        throw new WhatsAppProviderError("template_catalog_invalid", false);
      for (const template of body.data as unknown[]) {
        if (
          typeof template !== "object" ||
          template === null ||
          !("name" in template) ||
          template.name !== request.templateName ||
          !("language" in template) ||
          template.language !== request.language ||
          !("status" in template) ||
          template.status !== "APPROVED" ||
          !("components" in template) ||
          !Array.isArray(template.components)
        )
          continue;
        const component = template.components.find(
          (value: unknown) =>
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "BUTTONS",
        ) as { buttons?: unknown } | undefined;
        const buttons = component?.buttons;
        const requiresParameters = template.components.some(
          (component: unknown) => {
            if (
              typeof component !== "object" ||
              component === null ||
              !("type" in component)
            )
              return true;
            if (component.type !== "BODY" && component.type !== "HEADER")
              return false;
            if (
              component.type === "HEADER" &&
              (!("format" in component) || component.format !== "TEXT")
            )
              return true;
            return (
              !("text" in component) ||
              typeof component.text !== "string" ||
              component.text.includes("{{")
            );
          },
        );
        if (
          !requiresParameters &&
          Array.isArray(buttons) &&
          buttons.length === 2 &&
          request.buttonIndices.every((index, position) => {
            const button: unknown = buttons[index];
            return (
              typeof button === "object" &&
              button !== null &&
              "type" in button &&
              button.type === "QUICK_REPLY" &&
              "text" in button &&
              button.text === request.buttonTexts[position]
            );
          })
        )
          return true;
      }
      const paging = "paging" in body ? body.paging : undefined;
      const cursors =
        typeof paging === "object" && paging !== null && "cursors" in paging
          ? paging.cursors
          : undefined;
      const next =
        typeof paging === "object" && paging !== null && "next" in paging
          ? paging.next
          : undefined;
      const after =
        typeof cursors === "object" && cursors !== null && "after" in cursors
          ? cursors.after
          : undefined;
      if (next === undefined) return false;
      if (
        typeof after !== "string" ||
        after.length === 0 ||
        after.length > 2048 ||
        hasControlCharacters(after) ||
        after === cursor
      )
        throw new WhatsAppProviderError(
          "template_catalog_cursor_invalid",
          false,
        );
      cursor = after;
    }
    throw new WhatsAppProviderError("template_catalog_pagination_limit", false);
  }

  public async acknowledgeInbound(
    request: WhatsAppInboundAcknowledgement,
  ): Promise<void> {
    if (!this.#options.enabled)
      throw new WhatsAppProviderError("provider_disabled", false);
    const {
      accessToken,
      graphApiVersion: version,
      phoneNumberId,
    } = this.#options;
    if (request.senderPhoneNumberId !== phoneNumberId)
      throw new WhatsAppProviderError("sender_configuration_changed", false);
    if (
      (!accessToken && request.accessTokenForAttempt === undefined) ||
      !version ||
      !graphVersion.test(version) ||
      !phoneNumberId ||
      !resourceId.test(phoneNumberId)
    )
      throw new WhatsAppProviderError("provider_not_configured", false);
    if (!/^wamid\.[A-Za-z0-9+/=_-]{1,1024}$/u.test(request.providerMessageId))
      throw new TypeError("invalid inbound provider message identifier");
    // This best-effort signal never retries or sleeps behind rate limits. The
    // ingestion caller handles failure separately from durable reply work.
    await request.beforeAttempt();
    const attemptToken =
      request.accessTokenForAttempt === undefined
        ? accessToken
        : ((await request.accessTokenForAttempt()) ?? accessToken);
    if (!attemptToken)
      throw new WhatsAppProviderError("provider_not_configured", false);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.#options.timeoutMs ?? 1000, 1000),
    );
    try {
      const response = await (this.#options.fetch ?? fetch)(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${attemptToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            status: "read",
            message_id: request.providerMessageId,
            typing_indicator: { type: "text" },
          }),
          signal: controller.signal,
        },
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new WhatsAppProviderError(
          `acknowledgement_http_${String(response.status)}`,
          response.status === 429 || response.status >= 500,
          response.status,
        );
    } catch (error) {
      if (error instanceof WhatsAppProviderError) throw error;
      throw new WhatsAppProviderError("acknowledgement_transport_error", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  public async downloadMedia(
    request: WhatsAppMediaDownloadRequest,
  ): Promise<WhatsAppMediaDownloadResult> {
    if (!this.#options.enabled)
      throw new WhatsAppProviderError("provider_disabled", false);
    const { accessToken, graphApiVersion: version } = this.#options;
    if (
      request.senderPhoneNumberId !== undefined &&
      request.senderPhoneNumberId !== this.#options.phoneNumberId
    )
      throw new WhatsAppProviderError("sender_configuration_changed", false);
    if (
      (accessToken === undefined &&
        request.accessTokenForAttempt === undefined) ||
      version === undefined ||
      !graphVersion.test(version) ||
      !resourceId.test(request.mediaId)
    )
      throw new WhatsAppProviderError("provider_not_configured", false);
    const execute = this.#options.fetch ?? fetch;
    const requestWithTimeout = async (url: string): Promise<Response> => {
      await request.beforeAttempt?.();
      const attemptToken =
        request.accessTokenForAttempt === undefined
          ? accessToken
          : ((await request.accessTokenForAttempt()) ?? accessToken);
      if (!attemptToken)
        throw new WhatsAppProviderError("provider_not_configured", false);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#options.timeoutMs ?? 8_000,
      );
      try {
        return await execute(url, {
          method: "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${attemptToken}` },
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
    const metadataBytes = await boundedMediaBody(
      metadataResponse,
      32 * 1024,
      this.#options.timeoutMs ?? 8_000,
    );
    let metadata: Readonly<Record<string, unknown>>;
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes),
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new TypeError("media metadata must be an object");
      metadata = parsed as Readonly<Record<string, unknown>>;
    } catch {
      throw new WhatsAppProviderError("media_metadata_invalid", false);
    }
    const mediaUrl =
      typeof metadata.url === "string" ? metadata.url : undefined;
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
      (typeof metadata.mime_type === "string"
        ? metadata.mime_type.toLowerCase()
        : "");
    if (
      declared !== "image/jpeg" &&
      declared !== "image/png" &&
      declared !== "image/webp" &&
      declared !== "application/pdf" &&
      declared !== "video/mp4" &&
      declared !== "audio/ogg" &&
      declared !== "audio/wav"
    )
      throw new WhatsAppProviderError("media_content_type_unsupported", false);
    if (
      request.expectedMimeType !== undefined &&
      request.expectedMimeType.split(";", 1)[0]?.trim().toLowerCase() !==
        declared
    )
      throw new WhatsAppProviderError("media_content_type_mismatch", false);
    const maximumBytes =
      declared.startsWith("audio/") || declared === "video/mp4"
        ? 16 * 1024 * 1024
        : 20 * 1024 * 1024;
    const contentLength = Number(mediaResponse.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes)
      throw new WhatsAppProviderError("media_too_large", false);
    const bytes = await boundedMediaBody(
      mediaResponse,
      maximumBytes,
      this.#options.timeoutMs ?? 8_000,
    );
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
      (accessToken === undefined &&
        request.accessTokenForAttempt === undefined) ||
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
      request.maximumAttempts ?? 5,
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let retryAfterMs = 0;
      // Authorization is re-read after every rate-limit delay. Refusal occurs
      // before HTTP and is not an ambiguous provider outcome or a retry signal.
      await request.beforeAttempt?.();
      const attemptToken =
        request.accessTokenForAttempt === undefined
          ? accessToken
          : ((await request.accessTokenForAttempt()) ?? accessToken);
      if (!attemptToken)
        throw new WhatsAppProviderError("provider_not_configured", false);
      request.onAttemptStarted?.();
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
              authorization: `Bearer ${attemptToken}`,
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
        if (retryable) {
          const header = response.headers.get("retry-after")?.trim();
          if (header !== undefined) {
            const delay = /^\d+$/u.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - Date.now();
            if (Number.isFinite(delay) && delay > 0) {
              if (delay > 30_000)
                throw new WhatsAppProviderError(
                  "rate_limit_deferred",
                  true,
                  429,
                  metaDiagnostic(payload, response.status, true),
                  delay,
                );
              retryAfterMs = delay;
            }
          }
        }
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
            retryAfterMs > 0 ? retryAfterMs : undefined,
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
      const delay = Math.max(
        retryAfterMs,
        Math.min(2000, 200 * 2 ** (attempt - 1) + jitter),
      );
      await (
        this.#options.wait ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(delay);
    }
    throw new WhatsAppProviderError("retry_exhausted", true);
  }
}

export class RoutedMetaWhatsAppProvider implements WhatsAppProvider {
  public readonly name = "meta" as const;
  readonly #byPhoneNumberId: ReadonlyMap<string, MetaWhatsAppProvider>;

  public constructor(accounts: readonly MetaWhatsAppProviderOptions[]) {
    const providers = new Map<string, MetaWhatsAppProvider>();
    for (const account of accounts) {
      if (
        account.phoneNumberId === undefined ||
        providers.has(account.phoneNumberId)
      )
        throw new TypeError("WhatsApp account phone number IDs must be unique");
      providers.set(account.phoneNumberId, new MetaWhatsAppProvider(account));
    }
    this.#byPhoneNumberId = providers;
  }

  public async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
    const provider = this.#provider(request.senderPhoneNumberId);
    return provider.send(request);
  }

  public async verifyTemplate(
    request: WhatsAppTemplateVerificationRequest,
  ): Promise<boolean> {
    return this.#provider(request.senderPhoneNumberId).verifyTemplate(request);
  }

  public async acknowledgeInbound(
    request: WhatsAppInboundAcknowledgement,
  ): Promise<void> {
    return this.#provider(request.senderPhoneNumberId).acknowledgeInbound(
      request,
    );
  }

  public async downloadMedia(
    request: WhatsAppMediaDownloadRequest,
  ): Promise<WhatsAppMediaDownloadResult> {
    const provider = this.#provider(request.senderPhoneNumberId);
    return provider.downloadMedia(request);
  }

  #provider(phoneNumberId: string | undefined): MetaWhatsAppProvider {
    const provider =
      phoneNumberId === undefined
        ? undefined
        : this.#byPhoneNumberId.get(phoneNumberId);
    if (provider === undefined)
      throw new WhatsAppProviderError("sender_configuration_changed", false);
    return provider;
  }
}
