// @vitest-environment jsdom
import "./dialog-test-support";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactDetail } from "@or-on/crm";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";

const transport = vi.hoisted(() => ({ mutate: vi.fn() }));
const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => navigation,
}));
vi.mock("../src/features/crm", () => ({ crmMutation: transport.mutate }));
vi.mock("../src/features/voice", () => ({ voiceMutation: transport.mutate }));
import { ContactDetailPanel, ContactManager } from "../src/features/contacts";
import { FormValidation } from "../src/i18n/form-validation";
import { OperationsPanel } from "../src/features/operations";
import { ManagementPanel } from "../src/features/management";

const contact: ContactDetail = {
  id: "fictional-contact",
  name: "Fictional Customer",
  email: null,
  company: null,
  lifecycleStatus: "active",
  voiceConsent: "unknown",
  whatsAppConsent: "unknown",
  whatsAppOptedOutAt: null,
  lastActivityAt: null,
  createdAt: "2026-09-03T00:00:00Z",
  identities: [],
  tags: [],
  notes: [],
  customFields: [],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("form recovery and permission presentation", () => {
  it("keeps contact profile editing available when the optional voice service is down", () => {
    render(
      localized(
        <ContactDetailPanel
          contact={contact}
          activity={[]}
          voiceAvailable={false}
        />,
      ),
    );
    expect(
      screen
        .getByText(en.contacts.voiceServiceUnavailable)
        .getAttribute("role"),
    ).toBe("status");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: en.tenantPrimary.call,
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: en.premiumPrimary.profileEdit }),
    );
    expect(
      screen.getByRole("dialog", { name: en.premiumPrimary.profileEdit }),
    ).toBeTruthy();
    expect(transport.mutate).not.toHaveBeenCalled();
  });
  it("renders contact dates in the explicit tenant timezone", () => {
    const view = render(
      localized(
        <ContactDetailPanel
          contact={contact}
          activity={[]}
          timezone="America/Los_Angeles"
        />,
      ),
    );
    expect(
      view.container.querySelector(`time[datetime="${contact.createdAt}"]`)
        ?.textContent,
    ).toBe("Sep 2, 2026");
  });
  it("keeps the relationship readable and opens focused profile and permission dialogs", () => {
    const view = render(
      localized(<ContactDetailPanel contact={contact} activity={[]} />),
    );
    const profile = screen.getByRole("complementary", {
      name: en.contacts.profile,
    });
    expect(
      within(profile).getByRole("heading", {
        name: en.premiumPrimary.profileFacts,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: en.premiumPrimary.profileEdit }),
    );
    const profileDialog = screen.getByRole("dialog", {
      name: en.premiumPrimary.profileEdit,
    });
    expect(
      within(profileDialog).getByRole("textbox", { name: "Name" }),
    ).toBeTruthy();
    expect(
      within(profileDialog).getByRole("combobox", { name: "Voice consent" }),
    ).toBeTruthy();
    fireEvent.click(
      within(profileDialog).getByRole("button", { name: en.common.close }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantPrimary.call }),
    );
    const permissions = screen.getByRole("dialog", {
      name: en.tenantPrimary.call,
    });
    expect(
      within(permissions).queryByRole("combobox", { name: "Voice consent" }),
    ).toBeNull();
    expect(
      within(permissions).queryByRole("combobox", { name: "WhatsApp consent" }),
    ).toBeNull();
    fireEvent.click(
      within(permissions).getByRole("button", { name: en.common.close }),
    );
    const workRail = view.container.querySelector<HTMLElement>(
      ".contact-record__main",
    );
    if (!workRail) throw new Error("Contact work rail missing");
    expect(
      within(workRail)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([en.contacts.activity]);
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }));
    expect(
      within(workRail).getByRole("textbox", { name: "Add an internal note" }),
    ).toBeTruthy();
    expect(view.container.querySelector(".detail-grid")?.children).toHaveLength(
      2,
    );
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it("lets an authorized operator record voice consent for manual calling", async () => {
    transport.mutate.mockResolvedValue({});
    render(localized(<ContactDetailPanel contact={contact} activity={[]} />));
    fireEvent.click(
      screen.getByRole("button", { name: en.premiumPrimary.profileEdit }),
    );
    const profileDialog = screen.getByRole("dialog", {
      name: en.premiumPrimary.profileEdit,
    });
    fireEvent.change(
      within(profileDialog).getByRole("combobox", { name: "Voice consent" }),
      { target: { value: "granted" } },
    );
    fireEvent.click(
      within(profileDialog).getByRole("button", {
        name: en.contacts.saveProfile,
      }),
    );
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        `/api/crm/contacts/${contact.id}`,
        {
          name: contact.name,
          email: "",
          company: "",
          voiceConsent: "granted",
        },
        { method: "PATCH" },
      ),
    );
  });

  it("sends custom numeric and boolean fields as typed values", async () => {
    transport.mutate.mockResolvedValue({});
    render(
      localized(
        <ContactDetailPanel
          contact={{
            ...contact,
            customFields: [
              {
                id: "number-field",
                key: "capacity",
                label: "Capacity",
                fieldType: "number",
                value: 4,
              },
              {
                id: "boolean-field",
                key: "interested",
                label: "Interested",
                fieldType: "boolean",
                value: null,
              },
            ],
          }}
          activity={[]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Custom fields/ }));
    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Capacity",
    });
    fireEvent.change(number, { target: { value: "12.5" } });
    const numberForm = number.closest("form");
    if (!numberForm) throw new Error("Custom field form missing");
    fireEvent.submit(numberForm);
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        expect.stringContaining("number-field"),
        { value: 12.5 },
      ),
    );
    const boolean = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Interested",
    });
    await vi.waitFor(() => expect(boolean.matches(":disabled")).toBe(false));
    fireEvent.change(boolean, { target: { value: "false" } });
    const booleanForm = boolean.closest("form");
    if (!booleanForm) throw new Error("Custom field form missing");
    fireEvent.submit(booleanForm);
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        expect.stringContaining("boolean-field"),
        { value: false },
      ),
    );
  });
  it("keeps a partially imported CSV editable and redacts row diagnostics", async () => {
    transport.mutate.mockResolvedValueOnce({
      created: 1,
      skipped: 1,
      errors: [{ row: 3, reason: "private backend detail" }],
    });
    render(localized(<ContactManager contacts={[]} />));
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    const csv = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Paste CSV with name, phone, email, and company headers",
    });
    fireEvent.change(csv, {
      target: { value: "name,phone\nFictional,invalid" },
    });
    const form = csv.closest("form");
    if (!form) throw new Error("Import form missing");
    fireEvent.submit(form);
    await screen.findByText("Imported 1; skipped 1.");
    expect(csv.value).toContain("Fictional");
    expect(screen.queryByText(/private backend detail/u)).toBeNull();
  });
  it("localizes native required/email validation and clears stale validity on input", () => {
    render(
      localized(
        <FormValidation>
          <label>
            דוא״ל
            <input required type="email" />
          </label>
        </FormValidation>,
        "he",
      ),
    );
    const email = screen.getByRole<HTMLInputElement>("textbox", {
      name: "דוא״ל",
    });
    fireEvent.invalid(email);
    expect(email.validationMessage).toBe("יש למלא שדה זה.");
    fireEvent.input(email, { target: { value: "invalid" } });
    fireEvent.invalid(email);
    expect(email.validationMessage).toBe("יש להזין כתובת דוא״ל תקינה.");
    fireEvent.input(email, { target: { value: "fictional@example.invalid" } });
    expect(email.validity.valid).toBe(true);
  });
  it("retains a failed note and clears only after confirmed success", async () => {
    transport.mutate
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({});
    render(localized(<ContactDetailPanel contact={contact} activity={[]} />));
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }));
    const note = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Add an internal note",
    });
    fireEvent.change(note, { target: { value: "Fictional note to preserve" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await screen.findByText("Contact update failed");
    expect(note.value).toBe("Fictional note to preserve");
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await vi.waitFor(() => expect(note.value).toBe(""));
    expect(transport.mutate).toHaveBeenCalledTimes(2);
  });
  it("retains campaign input after a failed request", async () => {
    transport.mutate.mockRejectedValue(new Error("temporary failure"));
    render(
      localized(<OperationsPanel broadcasts={[]} automations={[]} runs={[]} />),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.premiumPrimary.newCampaign }),
    );
    const name = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Campaign name",
    });
    fireEvent.change(name, { target: { value: "Fictional draft" } });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message template" }),
      { target: { value: "Fictional body" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByText("Operation failed");
    expect(name.value).toBe("Fictional draft");
  });
  it("keeps an operations draft mounted while switching index tabs", () => {
    render(
      localized(<OperationsPanel broadcasts={[]} automations={[]} runs={[]} />),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.premiumPrimary.newCampaign }),
    );
    const name = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Campaign name",
    });
    fireEvent.change(name, { target: { value: "Fictional retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: en.common.close }));
    fireEvent.click(screen.getByRole("tab", { name: /Automations/u }));
    expect(
      screen
        .getByRole("tab", { name: /Automations/u })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /Campaigns/u }));
    fireEvent.click(
      screen.getByRole("button", { name: en.premiumPrimary.newCampaign }),
    );
    expect(name.value).toBe("Fictional retained draft");
  });
  it("honors a route-backed campaign creation intent after tab navigation", async () => {
    const view = render(
      localized(
        <OperationsPanel
          automations={[]}
          broadcasts={[]}
          initialTab="automations"
          runs={[]}
        />,
      ),
    );
    expect(
      screen
        .getByRole("tab", { name: /Automations/u })
        .getAttribute("aria-selected"),
    ).toBe("true");

    view.rerender(
      localized(
        <OperationsPanel
          automations={[]}
          broadcasts={[]}
          initialCreate="campaigns"
          runs={[]}
        />,
      ),
    );
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: /Campaigns/u })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(
      view.container
        .querySelector("#campaign-name")
        ?.closest("dialog")
        ?.hasAttribute("open"),
    ).toBe(true);
  });
  it("separates campaign and flow management permissions", () => {
    const view = render(
      localized(
        <OperationsPanel broadcasts={[]} automations={[]} runs={[]} />,
        "en",
        ["campaigns:manage"],
      ),
    );
    expect(
      view.container.querySelector("#campaign-name")?.matches(":disabled"),
    ).toBe(false);
    expect(
      view.container.querySelector("#automation-name")?.matches(":disabled"),
    ).toBe(true);

    view.rerender(
      localized(
        <OperationsPanel broadcasts={[]} automations={[]} runs={[]} />,
        "en",
        ["flows:manage"],
      ),
    );
    expect(
      view.container.querySelector("#campaign-name")?.matches(":disabled"),
    ).toBe(true);
    expect(
      view.container.querySelector("#automation-name")?.matches(":disabled"),
    ).toBe(false);
  });
  it("does not offer actionable write controls to a read-only role", () => {
    render(
      localized(<ContactDetailPanel contact={contact} activity={[]} />, "he", [
        "crm:read",
      ]),
    );
    const form = screen.getByRole("button", { name: "עריכת פרופיל" });
    expect((form as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.queryByRole("button", { name: en.contacts.remove }),
    ).toBeNull();
    expect(transport.mutate).not.toHaveBeenCalled();
  });
  it("reviews and removes a contact from the active directory", async () => {
    transport.mutate.mockResolvedValue({ ok: true });
    render(localized(<ContactDetailPanel contact={contact} activity={[]} />));

    fireEvent.click(screen.getByRole("button", { name: en.contacts.remove }));
    const review = screen.getByRole("dialog", {
      name: en.contacts.removeTitle,
    });
    expect(review.textContent).toContain(contact.name);
    expect(transport.mutate).not.toHaveBeenCalled();

    fireEvent.click(
      within(review).getByRole("button", {
        name: en.contacts.removeConfirm,
      }),
    );
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        `/api/crm/contacts/${contact.id}`,
        {},
        { method: "DELETE" },
      ),
    );
    expect(navigation.push).toHaveBeenCalledWith("/contacts");
    expect(navigation.refresh).toHaveBeenCalled();
  });
  it("requires caller identity and final review before admitting a real carrier call", async () => {
    transport.mutate.mockResolvedValue({ created: true });
    render(
      localized(
        <ContactDetailPanel
          activity={[]}
          contact={{
            ...contact,
            voiceConsent: "granted",
            identities: [
              {
                id: "voice-identity",
                channel: "phone",
                normalizedValue: "+14155550123",
                displayValue: "+1 415 555 0123",
                validationStatus: "valid",
                isPrimary: true,
              },
            ],
          }}
          realVoiceEnabled
          voiceFlows={[
            {
              flow_id: "702a2dd8-24d9-4d54-a571-89c69978d48a",
              language: "he",
              latest_version: 1,
              name: "Published conversation",
              packaged: false,
            },
          ]}
        />,
        "en",
        ["crm:read", "voice:operate"],
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantPrimary.call }),
    );
    const call = within(
      screen.getByRole("dialog", { name: en.tenantPrimary.call }),
    ).getByRole<HTMLButtonElement>("button", {
      name: en.tenantPrimary.call,
    });
    expect(call.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en.contacts.callerAddressForm), {
      target: { value: "male" },
    });
    expect(call.disabled).toBe(false);
    fireEvent.click(call);
    const review = screen.getByRole("dialog", {
      name: en.tenantPrimary.callReview,
    });
    expect(transport.mutate).not.toHaveBeenCalled();
    expect(review.textContent).toContain(en.contacts.callerAddressMale);
    const cancel = within(review).getByRole("button", {
      name: en.common.cancel,
    });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(review.hasAttribute("open")).toBe(false);
    expect(transport.mutate).not.toHaveBeenCalled();
    fireEvent.click(call);
    fireEvent.click(
      within(review).getByRole("button", { name: en.tenantPrimary.call }),
    );
    await vi.waitFor(() =>
      expect(transport.mutate).toHaveBeenCalledWith(
        "/api/voice/real-calls",
        expect.objectContaining({
          contactId: contact.id,
          callerGender: "male",
          explicitApproval: true,
          flowId: "702a2dd8-24d9-4d54-a571-89c69978d48a",
        }),
      ),
    );
    expect(transport.mutate).toHaveBeenCalledOnce();
  });
  it("labels a carrier admission failure as a call failure", async () => {
    transport.mutate.mockRejectedValue(new Error("Real call unavailable"));
    render(
      localized(
        <ContactDetailPanel
          activity={[]}
          contact={{
            ...contact,
            voiceConsent: "granted",
            identities: [
              {
                id: "voice-identity",
                channel: "phone",
                normalizedValue: "+14155550123",
                displayValue: "+1 415 555 0123",
                validationStatus: "valid",
                isPrimary: true,
              },
            ],
          }}
          realVoiceEnabled
          voiceFlows={[
            {
              flow_id: "702a2dd8-24d9-4d54-a571-89c69978d48a",
              language: "he",
              latest_version: 1,
              name: "Published conversation",
              packaged: false,
            },
          ]}
        />,
        "en",
        ["crm:read", "voice:operate"],
      ),
    );
    fireEvent.change(screen.getByLabelText(en.contacts.callerAddressForm), {
      target: { value: "female" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: en.tenantPrimary.call }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: en.tenantPrimary.call }),
      ).getByRole("button", { name: en.tenantPrimary.call }),
    );
    const review = screen.getByRole("dialog", {
      name: en.tenantPrimary.callReview,
    });
    fireEvent.click(
      within(review).getByRole("button", { name: en.tenantPrimary.call }),
    );
    expect(await screen.findByText(en.tenantPrimary.callFailed)).toBeTruthy();
    expect(screen.queryByText(en.contacts.updateFailed)).toBeNull();
  });
  it("keeps internal provider configuration out of tenant settings", () => {
    render(
      localized(
        <ManagementPanel
          account={{
            displayName: "Operator",
            email: "operator@example.test",
            isSuperuser: false,
          }}
          members={[]}
          notifications={[]}
          apiKeys={[]}
          currentUserId="00000000-0000-4000-8000-000000000002"
          invitations={[]}
          canManageTenant
          settings={{
            displayName: "Fictional workspace",
            defaultCurrency: "ILS",
            locale: "he",
            timezone: "Asia/Jerusalem",
          }}
          tenantName="Fictional workspace"
        />,
      ),
    );
    expect(screen.queryByText("Real delivery enabled")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /API access/u }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Issue CRM key" })
        .disabled,
    ).toBe(false);
  });
});
