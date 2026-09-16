// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantSettings } from "@or-on/crm";

import { TenantSupportSettings } from "../src/features/management";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  crmMutation: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));

vi.mock("../src/features/crm", () => ({
  crmMutation: state.crmMutation,
}));

const settings: TenantSettings = {
  displayName: "Example Workspace",
  defaultCurrency: "ILS",
  locale: "he",
  timezone: "Asia/Jerusalem",
  businessName: "Example Property Support",
  businessEmail: null,
  businessPhone: null,
  businessAddress: null,
  accentToken: null,
  reportHeader: null,
  reportFooter: null,
  supportProfile: {
    schemaVersion: "1.0",
    displayName: "Example Property",
    supportDisplayName: "Example Property Support",
    authorizedAffiliations: [],
    productsAndServices: ["Property maintenance"],
    primaryLanguage: "he",
    supportedLanguages: ["he", "en"],
    timezone: "Asia/Jerusalem",
    businessHours: {
      monday: { closed: false, opensAt: "08:00", closesAt: "17:00" },
    },
    terminology: [
      {
        term: "Example Tower",
        pronunciation: "Example Tower",
        language: "en",
      },
    ],
  },
  identityVerification: {
    schemaVersion: "1.0",
    enabled: true,
    requiredFactors: ["fullName", "phone", "nationalId"],
    maxAttempts: 3,
    onFailure: "human_handoff",
    contextDisclosure: "after_verification",
  },
};

describe("tenant AI support settings", () => {
  beforeEach(() => {
    state.crmMutation.mockReset();
    state.crmMutation.mockResolvedValue({});
    state.refresh.mockReset();
  });

  afterEach(cleanup);

  it("edits structured identity, terminology and deterministic verification policy", async () => {
    render(
      localized(
        <TenantSupportSettings
          settings={settings}
          tenantName="Example Workspace"
        />,
      ),
    );

    expect(
      screen.getByRole("heading", {
        name: "AI support identity and verification",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/\{\s*"schemaVersion"/u)).toBeNull();

    fireEvent.change(screen.getByLabelText("Name the support agent must use"), {
      target: { value: "Example Tenant Care" },
    });
    fireEvent.click(screen.getByLabelText("Customer number"));
    fireEvent.change(screen.getByLabelText("Maximum attempts"), {
      target: { value: "4" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save AI support settings" }),
    );

    await waitFor(() => expect(state.crmMutation).toHaveBeenCalledTimes(1));
    expect(state.crmMutation).toHaveBeenCalledWith(
      "/api/settings",
      expect.any(Object),
      { method: "PATCH" },
    );
    const submitted = state.crmMutation.mock.calls[0]?.[1] as unknown;
    expect(submitted).toMatchObject({
      supportProfile: {
        supportDisplayName: "Example Tenant Care",
        terminology: [
          {
            term: "Example Tower",
            pronunciation: "Example Tower",
            language: "en",
          },
        ],
      },
      identityVerification: {
        schemaVersion: "1.0",
        enabled: true,
        requiredFactors: ["fullName", "phone", "nationalId", "customerNumber"],
        maxAttempts: 4,
        onFailure: "human_handoff",
        contextDisclosure: "after_verification",
      },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
