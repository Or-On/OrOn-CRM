import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  contact: vi.fn(),
  activity: vi.fn(),
  classifications: vi.fn(),
  dossier: vi.fn(),
  fieldService: vi.fn(),
  voiceClient: vi.fn(),
  flows: vi.fn(),
  tenant: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({
  getContactDetail: dependencies.contact,
  getCustomerDossier: dependencies.dossier,
  getFieldServiceFeatureState: dependencies.fieldService,
  listContactActivity: dependencies.activity,
  listCustomerClassifications: dependencies.classifications,
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withCurrentTenant: dependencies.tenant,
}));
vi.mock("../src/features/voice-server", () => ({
  voiceClient: dependencies.voiceClient,
}));
vi.mock("../src/features/contacts", () => ({
  ContactDetailPanel: ({ voiceAvailable }: { voiceAvailable: boolean }) => (
    <div>
      {voiceAvailable ? "contact with calling" : "contact without calling"}
    </div>
  ),
}));
vi.mock("../src/i18n/product-metadata", () => ({ productMetadata: vi.fn() }));
vi.mock("../src/i18n/product-heading", () => ({ ProductHeading: () => null }));
vi.mock("../src/i18n/access-denied", () => ({
  AccessDenied: () => <div>access denied</div>,
}));
vi.mock("next/navigation", () => ({
  redirect: dependencies.redirect,
  notFound: () => {
    throw new Error("not found");
  },
}));

import ContactDetailPage from "../src/app/contacts/[id]/page";
import { ForbiddenError, UnauthenticatedError } from "../src/features/auth";

const page = () =>
  ContactDetailPage({ params: Promise.resolve({ id: "fictional-contact" }) });

describe("contact page optional dependency isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dependencies.contact.mockResolvedValue({ id: "fictional-contact" });
    dependencies.activity.mockResolvedValue([]);
    dependencies.classifications.mockResolvedValue([]);
    dependencies.dossier.mockResolvedValue({
      address: null,
      classifications: [],
      contactId: "fictional-contact",
      documents: [],
      locations: [],
      nationalIdMasked: null,
      preferredLanguage: null,
    });
    dependencies.fieldService.mockResolvedValue({ effective: false });
    dependencies.tenant.mockImplementation(
      async (
        _permission: string,
        work: (sql: unknown, session: unknown) => Promise<unknown>,
      ) =>
        work(
          {},
          {
            isSuperuser: false,
            tenant: { role: "admin" },
          },
        ),
    );
    dependencies.voiceClient.mockResolvedValue({
      listVoiceFlows: dependencies.flows,
    });
    dependencies.flows.mockResolvedValue({ ok: true, data: { items: [] } });
    dependencies.redirect.mockImplementation(() => {
      throw new Error("redirected");
    });
  });

  it("shows available voice flows with a bounded transport timeout", async () => {
    expect(renderToStaticMarkup(await page())).toContain(
      "contact with calling",
    );
    expect(dependencies.voiceClient).toHaveBeenCalledWith("voice:read", {
      timeoutMs: 1500,
    });
    expect(dependencies.tenant).toHaveBeenCalledWith(
      "crm:read",
      expect.any(Function),
    );
  });

  it.each([
    new TypeError("fetch failed"),
    new DOMException("timeout", "TimeoutError"),
    new ForbiddenError(),
  ])(
    "retains core contact data when calling is unavailable (%s)",
    async (error) => {
      dependencies.flows.mockRejectedValue(error);
      expect(renderToStaticMarkup(await page())).toContain(
        "contact without calling",
      );
      expect(dependencies.contact).toHaveBeenCalled();
      expect(dependencies.activity).toHaveBeenCalled();
    },
  );

  it("handles a non-success voice HTTP response without hiding the contact", async () => {
    dependencies.flows.mockResolvedValue({
      ok: false,
      data: { error: "unavailable" },
    });
    expect(renderToStaticMarkup(await page())).toContain(
      "contact without calling",
    );
  });

  it("does not hide core CRM/database failures", async () => {
    const failure = new Error("CRM unavailable");
    dependencies.contact.mockRejectedValue(failure);
    await expect(page()).rejects.toBe(failure);
  });

  it("preserves tenant permission denials", async () => {
    dependencies.tenant.mockRejectedValue(new ForbiddenError());
    expect(renderToStaticMarkup(await page())).toContain("access denied");
  });

  it("preserves expired-session redirection", async () => {
    dependencies.voiceClient.mockRejectedValue(new UnauthenticatedError());
    await expect(page()).rejects.toThrow("redirected");
    expect(dependencies.redirect).toHaveBeenCalledWith("/login");
  });
});
