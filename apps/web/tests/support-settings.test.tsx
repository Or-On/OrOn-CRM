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
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

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

  it("saves freeform company prose and long service paragraphs without truncation", async () => {
    render(
      localized(
        <TenantSupportSettings
          settings={settings}
          tenantName="Example Workspace"
        />,
      ),
    );
    const description =
      "Company description with factual service scope. ".repeat(60);
    const service =
      "Detailed service scope with support hours, limitations and onboarding assistance. ".repeat(
        12,
      );
    fireEvent.change(
      screen.getByLabelText(en.tenantSupportSettings.businessDescription),
      { target: { value: description } },
    );
    fireEvent.change(
      screen.getByLabelText(en.tenantSupportSettings.productsAndServices),
      { target: { value: `${service}\r\n\r\nשירות נוסף לצוותים\n` } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantSupportSettings.save }),
    );
    await waitFor(() => expect(state.crmMutation).toHaveBeenCalledTimes(1));
    expect(state.crmMutation.mock.calls[0]?.[1]).toMatchObject({
      supportProfile: {
        businessDescription: description.trim(),
        productsAndServices: [service.trim(), "שירות נוסף לצוותים"],
      },
    });
    expect(screen.getByText(en.tenantSupportSettings.saved)).toBeTruthy();
  });

  it("explains a too-long service entry locally and preserves the draft in Hebrew", async () => {
    render(
      localized(
        <TenantSupportSettings
          settings={settings}
          tenantName="Example Workspace"
        />,
        "he",
      ),
    );
    const field = screen.getByLabelText<HTMLTextAreaElement>(
      he.tenantSupportSettings.productsAndServices,
    );
    const draft = "ת".repeat(4_001);
    fireEvent.change(field, { target: { value: draft } });
    fireEvent.click(
      screen.getByRole("button", { name: he.tenantSupportSettings.save }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(he.tenantSupportSettings.servicesLimit),
      ).toBeTruthy(),
    );
    expect(state.crmMutation).not.toHaveBeenCalled();
    expect(field.value).toBe(draft);
  });

  it("maps safe server validation errors to guidance instead of a generic failure", async () => {
    state.crmMutation.mockRejectedValue(
      new Error("tenant support profile is invalid"),
    );
    render(
      localized(
        <TenantSupportSettings
          settings={settings}
          tenantName="Example Workspace"
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantSupportSettings.save }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(en.tenantSupportSettings.profileInvalid),
      ).toBeTruthy(),
    );
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("keeps an oversized pasted description intact and explains how to shorten it", async () => {
    render(
      localized(
        <TenantSupportSettings
          settings={settings}
          tenantName="Example Workspace"
        />,
      ),
    );
    const field = screen.getByLabelText<HTMLTextAreaElement>(
      en.tenantSupportSettings.businessDescription,
    );
    expect(field.hasAttribute("maxLength")).toBe(false);
    const draft = "x".repeat(12_001);
    fireEvent.change(field, { target: { value: draft } });
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantSupportSettings.save }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(en.tenantSupportSettings.descriptionLimit),
      ).toBeTruthy(),
    );
    expect(state.crmMutation).not.toHaveBeenCalled();
    expect(field.value).toBe(draft);
  });
});
