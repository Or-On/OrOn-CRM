// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Expense } from "@or-on/crm";

import { FinanceWorkspace } from "../src/features/finance";
import { localized } from "./localized";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Finance workspace hydration", () => {
  const originalTimeZone = process.env.TZ;

  afterEach(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("hydrates without changing calendar output across server and browser timezones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T22:30:00.000Z"));
    const boundaryExpense: Expense = {
      id: "boundary-expense",
      createdByUserId: "operator-owner",
      title: "Near-midnight expense",
      vendor: "Fictional vendor",
      category: "Operations",
      amount: "125.50",
      currency: "USD",
      status: "recorded",
      sourceKind: "manual",
      sourceReference: null,
      notes: null,
      incurredAt: "2026-08-31T22:30:00.000Z",
      createdAt: "2026-08-31T22:30:00.000Z",
      updatedAt: "2026-08-31T22:30:00.000Z",
    };
    const workspace = (
      <FinanceWorkspace
        defaultCurrency="USD"
        initialExpenses={[boundaryExpense]}
        initialNextCursor={null}
        initialSummary={{
          totals: [
            {
              currency: "USD",
              recordedTotal: "125.50",
              pendingTotal: "0",
              recordedCount: 1,
              pendingCount: 0,
            },
          ],
          expenseCount: 1,
          recordedCount: 1,
          pendingCount: 0,
          voidCount: 0,
        }}
        referenceTime="2026-09-16T22:30:00.000Z"
        tenantTimeZone="Asia/Jerusalem"
        voiceEstimateAvailable={false}
        voiceEstimates={[]}
      />
    );

    process.env.TZ = "UTC";
    const serverMarkup = renderToString(localized(workspace));
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.append(container);

    process.env.TZ = "Asia/Jerusalem";
    const recoverableErrors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, localized(workspace), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await Promise.resolve();
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toContain("Sep 1, 2026");
    const monthLabel = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "This month",
    );
    expect(monthLabel?.closest("article")?.textContent).toContain("$125.50");
    act(() => root?.unmount());
  });

  it("falls back deterministically when the server reference is invalid", () => {
    process.env.TZ = "Asia/Jerusalem";
    expect(() =>
      renderToString(
        localized(
          <FinanceWorkspace
            defaultCurrency="USD"
            initialExpenses={[]}
            initialNextCursor={null}
            initialSummary={{
              totals: [],
              expenseCount: 0,
              recordedCount: 0,
              pendingCount: 0,
              voidCount: 0,
            }}
            referenceTime="not-a-date"
            tenantTimeZone="Invalid/TimeZone"
            voiceEstimateAvailable={false}
            voiceEstimates={[]}
          />,
        ),
      ),
    ).not.toThrow();
  });
});
