// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageActivityChart, Overview } from "../src/features/overview";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";
import { localized } from "./localized";

afterEach(cleanup);
describe("recorded message activity", () => {
  it.each(["en", "he"] as const)(
    "exposes exact recorded values through keyboard focus and a data table (%s)",
    (locale) => {
      const messages = locale === "he" ? he : en;
      const days = Array.from({ length: 14 }, (_, index) => ({
        day: `2026-09-${String(index + 1).padStart(2, "0")}`,
        inbound: index,
        outbound: index * 2,
      }));
      const { container } = render(
        localized(<MessageActivityChart days={days} />, locale),
      );
      expect(
        container.querySelector("path.overview-chart-line--animated"),
      ).toBeTruthy();
      expect(
        container.querySelector("path.overview-chart-line--guide"),
      ).toBeNull();
      expect(container.querySelector(".overview-chart-trend")).toBeTruthy();
      expect(container.querySelector(".overview-chart-bar")).toBeNull();
      const bars = screen.getAllByRole("button");
      expect(bars).toHaveLength(14);
      const labels = [
        ...container.querySelectorAll(".overview-bar-day"),
      ].filter((label) => label.textContent);
      expect(labels).toHaveLength(4);
      const focused = bars[5];
      if (!focused) throw new Error("Missing daily message button");
      fireEvent.focus(focused);
      expect(bars[5]?.getAttribute("aria-pressed")).toBe("true");
      expect(container.querySelector("[aria-live='polite']")?.textContent).toBe(
        bars[5]?.getAttribute("aria-label"),
      );
      fireEvent.click(screen.getByText(messages.premiumOverview.viewData));
      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("row")).toHaveLength(15);
      expect(within(table).getByRole("cell", { name: "26" })).toBeTruthy();
      expect(container.textContent).toContain(
        messages.premiumOverview.utcScope,
      );
    },
  );

  it("describes an empty period without creating fake activity", () => {
    const { container } = render(localized(<MessageActivityChart days={[]} />));
    expect(
      screen.getByText(en.premiumOverview.noRecordedActivity),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      container.querySelector(".overview-chart-summary .or-visually-hidden")
        ?.textContent,
    ).toBe("0");
  });

  it("changes to actual delivery outcomes without counting queued messages as successes", () => {
    const { container } = render(
      localized(
        <MessageActivityChart
          days={[
            {
              day: "2026-09-10",
              inbound: 12,
              outbound: 10,
              delivered: 6,
              failed: 2,
            },
          ]}
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: en.tenantOverview.outcomesView }),
    );
    expect(
      container.querySelector(".overview-chart-summary .or-visually-hidden")
        ?.textContent,
    ).toBe("8");
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain(
      "6 delivered or read, 2 failed",
    );
    expect(screen.getByText(en.tenantOverview.outcomeScope)).toBeTruthy();
  });

  it("renders a late activity spike as one uninterrupted animated path", () => {
    const { container } = render(
      localized(
        <MessageActivityChart
          days={Array.from({ length: 14 }, (_, index) => ({
            day: `2026-09-${String(index + 1).padStart(2, "0")}`,
            inbound: index === 12 ? 6 : index === 13 ? 1 : 0,
            outbound: index === 12 ? 6 : index === 13 ? 1 : 0,
          }))}
        />,
      ),
    );
    const paths = container.querySelectorAll(
      "path.overview-chart-line--animated",
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute("d")).toMatch(
      /L 912\.92\d* 12 L 988 170\.33\d*/u,
    );
    expect(paths[0]?.getAttribute("style")).not.toContain("path-length");
  });

  it("uses the reduced chart width for an animated audience data card", () => {
    const { container } = render(
      localized(
        <Overview
          dashboard={{
            contacts: 12,
            openConversations: 3,
            unreadMessages: 1,
            openPipelineValue: "0",
            openPipelineValues: [],
            messagesToday: 5,
          }}
          insights={{
            conversationStates: [],
            dailyMessages: [
              {
                day: "2026-09-11",
                delivered: 6,
                failed: 2,
                inbound: 4,
                outbound: 8,
              },
            ],
          }}
          metrics={{
            contacts: 12,
            openConversations: 3,
            pendingHandoffs: 0,
          }}
          operations={{
            monthStart: "2026-09-01",
            checkedAt: "2026-09-11T12:00:00.000Z",
            inbound: 4,
            outbound: 8,
            delivered: 6,
            failed: 2,
            awaiting: 0,
            contactsReached: 4,
            voiceSessions: 0,
            voiceActive: 0,
            voiceFailed: 0,
            agentEvents: 0,
            agentTokens: 0,
            flowRuns: 0,
            flowSucceeded: 0,
            flowFailed: 0,
            flowActive: 0,
          }}
          tenantName="Fictional workspace"
        />,
      ),
    );

    const reach = container.querySelector(".overview-reach-card");
    expect(reach).toBeTruthy();
    expect(reach?.textContent).toContain(en.tenantOverview.reachTitle);
    expect(
      reach?.querySelector(".overview-reach-primary .or-visually-hidden")
        ?.textContent,
    ).toBe("4");
    expect(container.querySelector(".overview-activity-chart")).toBeTruthy();
  });
});
