// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configurationFromTemplate,
  tenantFeatureKeys,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
  type TenantConfigurationState,
  type TenantFeatureSnapshot,
} from "@or-on/crm";

import { BusinessConfiguration } from "../src/features/business-configuration";
import { localized } from "./localized";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalTimeZone = process.env.TZ;
let root: ReturnType<typeof hydrateRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
  document.body.replaceChildren();
});

const configuration = configurationFromTemplate("leads_only");
const snapshot = Object.fromEntries(
  tenantFeatureKeys.map((key) => [
    key,
    {
      key,
      available: true,
      enabled: configuration.features.includes(key),
      effective: configuration.features.includes(key),
      configuration: {},
      configurationSchemaVersion: 1,
      source: "operator",
      revision: 1,
      updatedAt: "2026-10-04T23:30:00Z",
      updatedByUserId: null,
    },
  ]),
) as unknown as TenantFeatureSnapshot;

describe("business configuration history hydration", () => {
  it.each([
    ["en", true],
    ["he", true],
    ["en", false],
    ["he", false],
  ] as const)(
    "preserves %s history across host timezones (approved: %s)",
    async (locale, approved) => {
      const governance: TenantConfigurationState = {
        active: null,
        draft: null,
        initialConfiguration: configuration,
        canApprove: false,
        history: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            version: 1,
            revision: 1,
            status: approved ? "published" : "rejected",
            configuration,
            createdAt: "2026-10-04T23:30:00Z",
            submittedAt: "2026-10-04T23:30:00Z",
            approvedAt: approved ? "2026-10-04T23:30:00Z" : null,
            approvedByUserId: null,
            reviewNotes: null,
          },
        ],
      };
      const workspace = localized(
        <BusinessConfiguration
          definitions={tenantFeatureRegistry}
          initialFeatures={snapshot}
          initialProcesses={[]}
          initialGovernance={governance}
          options={{ agents: [], flows: [] }}
          templates={tenantTemplateRegistry}
        />,
        locale,
      );

      process.env.TZ = "UTC";
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
      const serverMarkup = renderToString(workspace);
      const container = document.createElement("div");
      container.innerHTML = serverMarkup;
      document.body.append(container);
      const history = container.querySelector(
        "#business-configuration-history-panel ol",
      );
      expect(
        container.querySelector<HTMLElement>(
          "#business-configuration-history-panel",
        )?.hidden,
      ).toBe(true);

      process.env.TZ = "Asia/Jerusalem";
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
        "Asia/Jerusalem",
      );
      const recoverableErrors: unknown[] = [];
      await act(async () => {
        root = hydrateRoot(container, workspace, {
          onRecoverableError: (error) => recoverableErrors.push(error),
        });
        await Promise.resolve();
      });

      expect(recoverableErrors).toEqual([]);
      // Hydration must retain the server tree, including initially hidden tabs.
      expect(
        container.querySelector("#business-configuration-history-panel ol"),
      ).toBe(history);
      const expectedDate = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        ...(approved ? { timeStyle: "short" as const } : {}),
        timeZone: "Asia/Jerusalem",
      }).format(new Date("2026-10-04T23:30:00Z"));
      expect(history?.textContent).toContain(expectedDate);
    },
  );
});
