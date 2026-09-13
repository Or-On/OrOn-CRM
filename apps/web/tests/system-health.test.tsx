// @vitest-environment jsdom
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../src/i18n/messages/en.json";
import { HealthPanel } from "../src/features/system-health";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderHealth() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HealthPanel />
    </NextIntlClientProvider>,
  );
}

const runtimeGates = {
  whatsappDelivery: true,
  whatsappAi: true,
  voiceCalling: false,
  automaticCallbacks: false,
};

function healthSnapshot({ live = true, ready = true } = {}) {
  return {
    checkedAt: "2026-09-10T10:00:00Z",
    runtimeGates,
    controlApi: {
      liveness: { ok: live, status: live ? 200 : 503, durationMs: 18 },
      readiness: {
        ok: ready,
        status: ready ? 200 : 503,
        durationMs: 24,
        data: {
          dependencies: { postgres: ready ? "ready" : "unavailable" },
        },
      },
    },
  };
}

describe("system availability", () => {
  it.each([
    {},
    { checkedAt: "invalid", controlApi: null },
    { checkedAt: new Date().toISOString(), controlApi: {} },
    {
      checkedAt: "2026-09-10T10:00:00Z",
      controlApi: {
        liveness: { ok: true, status: 200 },
        readiness: {
          ok: true,
          status: 200,
          data: { dependencies: { postgres: ["ready"] } },
        },
      },
    },
  ])("shows a retryable state for incomplete health data", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    renderHealth();
    expect(await screen.findByText(messages.health.unavailable)).toBeDefined();
    expect(
      screen.getByRole("button", { name: messages.health.again }),
    ).toBeDefined();
  });
  it("ends a stalled browser request, marks previous observations stale and enables retry", async () => {
    const healthy = healthSnapshot();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(healthy))
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    renderHealth();
    await screen.findByRole("heading", {
      name: messages.tenantHealth.operational,
    });
    fireEvent.click(screen.getByRole("checkbox"));
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: messages.health.refresh }),
    );
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(
      screen.getByRole("heading", { name: messages.tenantHealth.unknown }),
    ).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe(
      messages.tenantHealth.stale,
    );
    expect(
      screen
        .getByRole("button", { name: messages.health.refresh })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("recovers from an unavailable response without hiding database readiness", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("not JSON", { status: 502 }))
      .mockResolvedValueOnce(Response.json(healthSnapshot({ ready: false })));
    vi.stubGlobal("fetch", fetcher);
    renderHealth();
    fireEvent.click(
      await screen.findByRole("button", { name: messages.health.again }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: messages.tenantHealth.partial }),
      ).toBeDefined(),
    );
    expect(screen.queryByText(messages.health.healthy)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("distinguishes malformed data from observed service degradation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ unexpected: true })),
    );
    renderHealth();
    expect(
      await screen.findByText(messages.premiumVoice.healthMalformed),
    ).toBeDefined();
    expect(screen.queryByText(messages.health.degraded)).toBeNull();
    expect(screen.queryByText(messages.health.healthy)).toBeNull();
  });
  it("shows only the three actually observed checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(healthSnapshot())),
    );
    renderHealth();
    expect(
      await screen.findByRole("heading", {
        name: messages.tenantHealth.operational,
      }),
    ).toBeDefined();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(
      screen.getByText(messages.premiumVoice.serviceReadiness),
    ).toBeDefined();
    expect(screen.getByText(messages.tenantHealth.runtimeGates)).toBeDefined();
    expect(
      screen.getByText(messages.tenantHealth.whatsappDelivery),
    ).toBeDefined();
    expect(screen.getAllByText(messages.tenantHealth.configured)).toHaveLength(
      2,
    );
    expect(screen.getAllByText(messages.tenantHealth.disabled)).toHaveLength(2);
  });
  it("retains explicitly stale results after a failed refresh without claiming an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(healthSnapshot()))
        .mockRejectedValueOnce(new Error("unreachable")),
    );
    renderHealth();
    await screen.findByRole("heading", {
      name: messages.tenantHealth.operational,
    });
    fireEvent.click(
      screen.getByRole("button", { name: messages.health.refresh }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      messages.tenantHealth.stale,
    );
    expect(
      screen.getByRole("heading", { name: messages.tenantHealth.unknown }),
    ).toBeDefined();
    expect(screen.getAllByText(messages.tenantHealth.staleLabel)).toHaveLength(
      3,
    );
    expect(
      screen.queryByRole("heading", { name: messages.tenantHealth.major }),
    ).toBeNull();
  });
  it.each([
    [false, false, "major"],
    [false, true, "degraded"],
  ] as const)(
    "classifies observed probe results (%s / %s)",
    async (live, ready, state) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(Response.json(healthSnapshot({ live, ready }))),
      );
      renderHealth();
      expect(
        await screen.findByRole("heading", {
          name: messages.tenantHealth[state],
        }),
      ).toBeDefined();
    },
  );
});
