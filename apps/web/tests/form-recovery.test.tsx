// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactDetail } from "@or-on/crm";
import { localized } from "./localized";

const transport = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
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
  it("does not offer actionable write controls to a read-only role", () => {
    render(
      localized(<ContactDetailPanel contact={contact} activity={[]} />, "he", [
        "crm:read",
      ]),
    );
    const form = screen.getByRole("button", { name: "שמירת פרופיל" });
    expect((form as HTMLButtonElement).disabled).toBe(true);
    expect(transport.mutate).not.toHaveBeenCalled();
  });
  it("reports actual configured provider mode without exposing credentials", () => {
    render(
      localized(
        <ManagementPanel
          members={[]}
          notifications={[]}
          apiKeys={[]}
          settings={{
            displayName: "Fictional workspace",
            defaultCurrency: "ILS",
            locale: "he",
            timezone: "Asia/Jerusalem",
          }}
          realWhatsAppEnabled
        />,
      ),
    );
    expect(screen.getByText("Real delivery enabled")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Issue CRM key" })
        .disabled,
    ).toBe(true);
  });
});
