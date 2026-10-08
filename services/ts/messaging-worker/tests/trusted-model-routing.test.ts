import { describe, expect, it, vi } from "vitest";
import {
  resolveTrustedModelRoute,
  resolveTrustedChannelCredential,
  type ModelConfigurationRecord,
  type ModelRoutingPorts,
  type PublishedModelBinding,
} from "../src/trusted-model-routing.js";

const tenantId = "00000000-0000-0000-0000-000000000001";
const agentVersionId = "00000000-0000-0000-0000-000000000002";
const actorUserId = "00000000-0000-0000-0000-000000000003";
const configurationId = "00000000-0000-0000-0000-000000000004";
const credentialId = "00000000-0000-0000-0000-000000000005";
const scope = {
  tenantId,
  agentVersionId,
  actorUserId,
  channel: "whatsapp" as const,
};
function fixture() {
  const binding: PublishedModelBinding = {
    tenantId,
    agentVersionId,
    published: true,
    validationStatus: "valid",
    authorized: true,
    modelConfigurationId: configurationId,
  };
  const configuration: ModelConfigurationRecord = {
    id: configurationId,
    tenantId,
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    credentialId,
    enabled: true,
    settings: { temperature: 0, maxTokens: 512 },
    dailyRequestLimit: 2,
  };
  const ports: {
    -readonly [
      Key in keyof ModelRoutingPorts<{ opaqueHandle: string }>
    ]: ModelRoutingPorts<{ opaqueHandle: string }>[Key];
  } = {
    readPublishedBinding: vi.fn(() => Promise.resolve(binding)),
    readConfiguration: vi.fn(() => Promise.resolve(configuration)),
    resolveCredential: vi.fn(() =>
      Promise.resolve({
        opaqueHandle: "synthetic-credential-handle",
      }),
    ),
    reserveDailyAttempt: vi.fn(() => Promise.resolve(true)),
  };
  return { binding, configuration, ports };
}
describe("published-version model routing", () => {
  it("resolves explicit Meta credentials only for the server's active tenant channel", async () => {
    const channel = {
      tenantId,
      channelId: configurationId,
      kind: "whatsapp",
      provider: "meta",
      status: "active",
      providerAccountId: "synthetic-account",
      credentialId,
    };
    const resolveCredential = vi.fn(() =>
      Promise.resolve({ opaqueHandle: "synthetic-meta" }),
    );
    const route = await resolveTrustedChannelCredential(
      tenantId,
      configurationId,
      { readChannel: () => Promise.resolve(channel), resolveCredential },
    );
    expect(route).toMatchObject({
      status: "configured",
      providerAccountId: "synthetic-account",
    });
    expect(resolveCredential).toHaveBeenCalledWith(
      tenantId,
      credentialId,
      "meta",
    );
    for (const patch of [
      { tenantId: actorUserId },
      { status: "revoked" },
      { provider: "simulator" },
    ]) {
      expect(
        await resolveTrustedChannelCredential(tenantId, configurationId, {
          readChannel: () => Promise.resolve({ ...channel, ...patch }),
          resolveCredential,
        }),
      ).toMatchObject({ status: "blocked" });
    }
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(
      await resolveTrustedChannelCredential(tenantId, configurationId, {
        readChannel: () => Promise.resolve(channel),
      }),
    ).toMatchObject({
      status: "blocked",
      reason: "channel_credential_resolution_unavailable",
    });
    expect(
      await resolveTrustedChannelCredential(tenantId, configurationId, {
        readChannel: () => Promise.resolve({ ...channel, credentialId: null }),
      }),
    ).toEqual({ status: "legacy" });
  });
  it("preserves legacy only for an authorized published NULL binding", async () => {
    const f = fixture();
    f.ports.readPublishedBinding = () =>
      Promise.resolve({
        ...f.binding,
        modelConfigurationId: null,
      });
    expect(await resolveTrustedModelRoute(scope, f.ports)).toEqual({
      status: "legacy",
    });
    expect(f.ports.resolveCredential).not.toHaveBeenCalled();
    f.ports.readPublishedBinding = () =>
      Promise.resolve({
        ...f.binding,
        modelConfigurationId: null,
        authorized: false,
      });
    expect(await resolveTrustedModelRoute(scope, f.ports)).toMatchObject({
      status: "blocked",
    });
  });
  it("rejects foreign, disabled and endpoint-bearing configurations without resolving credentials", async () => {
    for (const patch of [
      { tenantId: actorUserId },
      { enabled: false },
      { settings: { baseUrl: "http://127.0.0.1" } },
      { provider: "openai-compat" },
      { model: "../../metadata" },
    ]) {
      const f = fixture();
      f.ports.readConfiguration = () =>
        Promise.resolve({
          ...f.configuration,
          ...patch,
        });
      expect(await resolveTrustedModelRoute(scope, f.ports)).toMatchObject({
        status: "blocked",
      });
      expect(f.ports.resolveCredential).not.toHaveBeenCalled();
    }
  });
  it("blocks missing credential and quota adapters instead of using a global key", async () => {
    const f = fixture();
    const missingConfiguration = {
      ...f.ports,
      readConfiguration: () => Promise.resolve(null),
    };
    expect(await resolveTrustedModelRoute(scope, missingConfiguration)).toEqual(
      { status: "blocked", reason: "configuration_unavailable" },
    );
    const withoutCredential = { ...f.ports };
    delete withoutCredential.resolveCredential;
    expect(
      await resolveTrustedModelRoute(scope, withoutCredential),
    ).toMatchObject({
      status: "blocked",
      reason: "credential_resolution_unavailable",
    });
    const withoutQuota = { ...f.ports };
    delete withoutQuota.reserveDailyAttempt;
    expect(await resolveTrustedModelRoute(scope, withoutQuota)).toMatchObject({
      status: "blocked",
      reason: "quota_reservation_unavailable",
    });
    f.ports.resolveCredential = () =>
      Promise.reject(new Error("synthetic secret must not escape"));
    expect(await resolveTrustedModelRoute(scope, f.ports)).toEqual({
      status: "blocked",
      reason: "routing_dependency_unavailable",
    });
  });
  it("reserves every physical attempt and rechecks revocation before spending", async () => {
    const f = fixture();
    let used = 0;
    f.ports.reserveDailyAttempt = () => Promise.resolve(++used <= 2);
    const route = await resolveTrustedModelRoute(scope, f.ports);
    if (route.status !== "configured")
      throw new Error("Expected configured synthetic route");
    expect(route.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(route.settings.temperature).toBe(0);
    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, () => route.beforeAttempt()),
    );
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(
      2,
    );
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    f.ports.readConfiguration = () =>
      Promise.resolve({
        ...f.configuration,
        enabled: false,
      });
    await expect(route.beforeAttempt()).rejects.toThrow("model_route_changed");
    expect(used).toBe(3);
    f.ports.readConfiguration = () =>
      Promise.reject(new Error("synthetic database credential error"));
    await expect(route.beforeAttempt()).rejects.toThrow(
      "model_routing_dependency_unavailable",
    );
  });
});
