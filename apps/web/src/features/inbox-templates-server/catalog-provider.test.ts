import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTemplateCatalog } from "./catalog-provider";

const account = {
  tenantId: "tenant-a",
  channelId: "channel-a",
  wabaId: "12345",
  graphApiVersion: "v23.0",
  accessToken: "synthetic-secret",
};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

describe("read-only Meta catalog", () => {
  it("uses fixed Graph GET scope, follows only cursor, and isolates tenant/token cache", async () => {
    const requests: { path: string; token: string | undefined }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        token: request.headers.authorization,
      });
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "1",
              name: "synthetic_menu",
              language: "he",
              status: "APPROVED",
              category: "UTILITY",
              components: [
                { type: "BODY", text: "Hello {{1}}" },
                {
                  type: "BUTTONS",
                  buttons: [
                    {
                      type: "QUICK_REPLY",
                      text: "Services",
                      example: ["never expose"],
                    },
                  ],
                },
              ],
            },
          ],
          paging: {
            next: "https://evil.invalid/?access_token=must-not-follow",
            cursors: { after: "opaque-cursor" },
          },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server missing");
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      expect(url.origin).toBe("https://graph.facebook.com");
      expect(url.pathname).toBe("/v23.0/12345/message_templates");
      expect(init?.redirect).toBe("error");
      return fetch(
        `http://127.0.0.1:${String(address.port)}${url.pathname}${url.search}`,
        init,
      );
    };
    const catalog = createTemplateCatalog(fetcher);
    const first = await catalog(account, null);
    expect(first.after).toBe("opaque-cursor");
    expect(first.templates[0]?.buttons).toEqual([
      { type: "QUICK_REPLY", text: "Services" },
    ]);
    expect(JSON.stringify(first)).not.toContain("synthetic-secret");
    await catalog(account, null);
    expect(requests).toHaveLength(1);
    await catalog({ ...account, tenantId: "tenant-b" }, null);
    await catalog({ ...account, accessToken: "rotated-secret" }, null);
    await catalog(account, first.after);
    expect(requests).toHaveLength(4);
    expect(requests[3]?.path).toContain("after=opaque-cursor");
    expect(
      requests.every((request) => !request.path.includes("access_token")),
    ).toBe(true);
  });

  it("rejects malformed scopes and redacts provider error bodies", async () => {
    let calls = 0;
    const catalog = createTemplateCatalog(() => {
      calls++;
      return Promise.resolve(
        new Response("secret/provider account", { status: 429 }),
      );
    });
    await expect(
      catalog({ ...account, wabaId: "../other" }, null),
    ).rejects.toThrow("Invalid template catalog scope");
    expect(calls).toBe(0);
    await expect(catalog(account, null)).rejects.toThrow(
      "Template catalog provider unavailable",
    );
  });
});
