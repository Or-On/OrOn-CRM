// @vitest-environment jsdom
import "./dialog-test-support";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformTenantSummary } from "@or-on/crm";

import { TenantWorkspace } from "../src/features/tenants";
import { localized } from "./localized";

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh }),
}));
vi.mock("../src/features/crm", () => ({ crmMutation: state.mutate }));

const primary: PlatformTenantSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Primary workspace",
  slug: "primary-workspace",
  status: "active",
  defaultCurrency: "USD",
  locale: "en",
  timezone: "UTC",
  memberCount: 2,
  createdAt: "2026-09-12T10:00:00.000Z",
};
const secondary: PlatformTenantSummary = {
  ...primary,
  id: "20000000-0000-4000-8000-000000000001",
  name: "Secondary workspace",
  slug: "secondary-workspace",
  memberCount: 1,
};

describe("platform tenant deletion", () => {
  beforeEach(() => {
    state.mutate.mockReset().mockResolvedValue({ ok: true });
    state.refresh.mockReset();
  });

  afterEach(cleanup);

  it("requires the exact slug and removes the deleted tenant from the directory", async () => {
    render(
      localized(
        <TenantWorkspace
          currentTenantId={primary.id}
          tenants={[primary, secondary]}
        />,
      ),
    );

    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Switch to another tenant before deleting this one",
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Secondary workspace" }),
    );
    const confirm = screen.getByRole("button", { name: "Delete tenant" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Tenant URL slug"), {
      target: { value: secondary.slug },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: secondary.name }),
      ).toBeNull(),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      `/api/tenants/${secondary.id}`,
      {},
      { method: "DELETE" },
    );
    expect(state.refresh).toHaveBeenCalledOnce();
  });
});
