import { createHash } from "node:crypto";
import {
  parseTemplatePage,
  type WhatsAppTemplatePage,
} from "../inbox-templates";

export interface TemplateAccount {
  readonly tenantId: string;
  readonly channelId: string;
  readonly wabaId: string;
  readonly graphApiVersion: string;
  readonly accessToken: string;
  /** Server-only credential rotation identity; never included in catalog responses. */
  readonly bindingFingerprint?: string;
}

/** Cache only public catalog data; authorization and binding are resolved on every request. */
export function createTemplateCatalog(
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  const cache = new Map<
    string,
    { expires: number; page: WhatsAppTemplatePage }
  >();
  return async (
    account: TemplateAccount,
    after: string | null,
  ): Promise<WhatsAppTemplatePage> => {
    if (
      !/^\d+$/u.test(account.wabaId) ||
      !/^v\d+\.0$/u.test(account.graphApiVersion) ||
      (after !== null && (after.length > 2048 || /[\r\n]/u.test(after)))
    )
      throw new TypeError("Invalid template catalog scope");
    const key = JSON.stringify([
      account.tenantId,
      account.channelId,
      account.wabaId,
      account.graphApiVersion,
      createHash("sha256").update(account.accessToken).digest("hex"),
      account.bindingFingerprint ?? null,
      after,
    ]);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return structuredClone(cached.page);
    const url = new URL(
      `https://graph.facebook.com/${account.graphApiVersion}/${account.wabaId}/message_templates`,
    );
    url.searchParams.set(
      "fields",
      "id,name,language,status,category,components",
    );
    url.searchParams.set("limit", "50");
    if (after !== null) url.searchParams.set("after", after);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Template catalog provider unavailable");
    const text = await boundedCatalogBody(response);
    const page = {
      ...parseTemplatePage(JSON.parse(text) as unknown),
      fetchedAt: new Date(now()).toISOString(),
    };
    if (cache.size >= 100) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expires: now() + 30_000, page });
    return structuredClone(page);
  };
}

export async function boundedCatalogBody(
  response: Response,
  maximum = 1_000_000,
): Promise<string> {
  if (!response.body) throw new Error("Template catalog response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      const { value } = result;
      bytes += value.byteLength;
      if (bytes > maximum)
        throw new Error("Template catalog response too large");
      chunks.push(value);
      result = await reader.read();
    }
  } finally {
    await reader.cancel();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
