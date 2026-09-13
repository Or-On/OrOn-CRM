import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(webRoot, path), "utf8");
}

describe("server authorization contract", () => {
  it.each([
    ["src/app/api/crm/contacts/route.ts", "crm:write"],
    ["src/app/api/crm/deals/[id]/stage/route.ts", "pipelines:manage"],
    [
      "src/app/api/messaging/conversations/[id]/messages/route.ts",
      "messaging:operate",
    ],
    ["src/app/api/campaigns/route.ts", "campaigns:manage"],
    ["src/app/api/automations/route.ts", "flows:manage"],
    ["src/app/api/settings/invitations/route.ts", "members:manage"],
    ["src/app/api/settings/members/[id]/route.ts", "members:change-role"],
    ["src/app/api/settings/route.ts", "tenant:manage"],
    ["src/app/api/voice/real-calls/route.ts", "voice:operate"],
  ])("keeps %s behind %s", (path, permission) => {
    const route = source(path);
    expect(route).toMatch(/assert(?:Crm|Authenticated)Mutation\(/u);
    expect(route).toContain(`"${permission}"`);
  });

  it("keeps interactive agent grants behind voice operation permission", () => {
    expect(source("src/features/auth/server.ts")).toContain('"voice:operate"');
    expect(source("src/app/api/auth/live-grant/route.ts")).toContain(
      "issueLiveAgentGrant(resolved.session)",
    );
  });

  it("keeps tenant inventory and creation exclusive to platform super-admins", () => {
    const tenants = source("src/app/api/tenants/route.ts");
    expect(tenants.match(/session\.isSuperuser/g)).toHaveLength(2);
    expect(tenants).toContain('throw new ForbiddenError("Forbidden")');
  });
});
