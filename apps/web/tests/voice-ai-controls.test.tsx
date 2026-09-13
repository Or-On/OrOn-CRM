// @vitest-environment jsdom
import "./dialog-test-support";

import type { VoiceControlStatus } from "@or-on/api-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceAIControls } from "../src/features/voice";
import { localized } from "./localized";

const sessionId = "40000000-0000-4000-8000-000000000001";
const initial: VoiceControlStatus = {
  session_id: sessionId,
  epoch: 0,
  desired_mode: "ai",
  acknowledged_epoch: 0,
  worker_mode: "ai",
  acknowledged_at: "2026-09-12T12:00:00Z",
  command_id: null,
  status: "applied",
  active: true,
  can_operate: true,
  resume_required: false,
  human_connection: "not_managed",
};
const reply = (value: unknown, status = 200) =>
  Response.json(value, { status });
const fetchMock = vi.fn<typeof fetch>();
let current = initial;
let postResponse: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  current = { ...initial };
  postResponse = () => Promise.resolve(reply(current));
  fetchMock
    .mockReset()
    .mockImplementation((_url, options) =>
      options?.method === "POST"
        ? postResponse()
        : Promise.resolve(reply(current)),
    );
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  document.cookie = "or_on_csrf=fixture-token";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount(locale: "en" | "he" = "en") {
  await act(async () => {
    render(
      localized(
        <VoiceAIControls sessionId={sessionId} provider="livekit" active />,
        locale,
      ),
    );
    await Promise.resolve();
  });
}
function posts() {
  return fetchMock.mock.calls.filter(
    ([, options]) => options?.method === "POST",
  );
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}
function command(index = 0) {
  const value = posts()[index]?.[1]?.body;
  if (typeof value !== "string") throw new Error("expected serialized command");
  return JSON.parse(value) as Record<string, unknown>;
}

describe("active call AI controls", () => {
  it("loads fresh status on mount without sending any command", async () => {
    await mount();
    expect(posts()).toHaveLength(0);
    expect(
      screen.getByText("The worker has acknowledged that AI is active."),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/voice/sessions/${sessionId}/control`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });
  it.each([
    { active: false, provider: "livekit" },
    { active: true, provider: "simulator" },
  ])("does not fetch or show controls for %o", (props) => {
    const result = render(
      localized(<VoiceAIControls sessionId={sessionId} {...props} />),
    );
    expect(result.container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never exposes mutation buttons to a fresh read-only snapshot", async () => {
    current = { ...initial, can_operate: false };
    await mount();
    expect(screen.queryByRole("button", { name: "Pause AI" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume AI" })).toBeNull();
    expect(screen.getByText(/Read-only access/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
  it("shows pause as pending until the worker acknowledges the same epoch", async () => {
    postResponse = () => {
      current = {
        ...initial,
        epoch: 1,
        desired_mode: "paused",
        status: "pending",
        command_id: "50000000-0000-4000-8000-000000000001",
      };
      return Promise.resolve(reply(current));
    };
    await mount();
    await click("Pause AI");
    expect(
      screen.getByText("Pause requested; waiting for worker acknowledgement."),
    ).toBeTruthy();
    expect(
      screen.queryByText("The worker has acknowledged that AI is paused."),
    ).toBeNull();
    expect(command()).toMatchObject({ mode: "paused", expected_epoch: 0 });
    expect(posts()[0]?.[1]?.headers).toMatchObject({
      "x-csrf-token": "fixture-token",
    });
    current = {
      ...current,
      acknowledged_epoch: 1,
      worker_mode: "paused",
      status: "applied",
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(
      screen.getByText("The worker has acknowledged that AI is paused."),
    ).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });
  it("requires explicit confirmation to resume an unavailable worker without claiming human connection", async () => {
    current = {
      ...initial,
      status: "worker_unavailable",
      resume_required: true,
    };
    await mount();
    expect(screen.getByText(/AI state is not confirmed/)).toBeTruthy();
    await click("Resume AI");
    expect(posts()).toHaveLength(0);
    expect(
      screen.getByRole("dialog", { name: "Resume AI in this call?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/paid processing in the existing call/),
    ).toBeTruthy();
    postResponse = () => {
      current = {
        ...initial,
        epoch: 1,
        status: "pending",
        command_id: "50000000-0000-4000-8000-000000000001",
      };
      return Promise.resolve(reply(current));
    };
    const confirm = screen.getAllByRole("button", { name: "Resume AI" }).at(-1);
    if (!confirm) throw new Error("resume confirmation required");
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });
    expect(command()).toMatchObject({ mode: "ai", expected_epoch: 0 });
    expect(
      screen.getByText("Resume requested; waiting for worker acknowledgement."),
    ).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });
  it("reloads stale epoch 409 without retrying the command", async () => {
    await mount();
    postResponse = () => {
      current = {
        ...initial,
        epoch: 2,
        desired_mode: "paused",
        worker_mode: "paused",
        acknowledged_epoch: 2,
      };
      return Promise.resolve(reply({ error: "stale" }, 409));
    };
    await click("Pause AI");
    expect(posts()).toHaveLength(1);
    expect(screen.getByText(/your command was not retried/)).toBeTruthy();
    expect(
      screen.getByText("The worker has acknowledged that AI is paused."),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(posts()).toHaveLength(1);
  });
  it("permits confirmed recovery when desired AI is pending but the worker requires explicit resume", async () => {
    current = {
      ...initial,
      epoch: 2,
      acknowledged_epoch: 2,
      desired_mode: "ai",
      worker_mode: "paused",
      status: "pending",
      resume_required: true,
    };
    await mount();
    await click("Resume AI");
    expect(
      screen.getByRole("dialog", { name: "Resume AI in this call?" }),
    ).toBeTruthy();
    expect(posts()).toHaveLength(0);
    postResponse = () => {
      current = { ...current, epoch: 3, resume_required: false };
      return Promise.resolve(reply(current));
    };
    const confirm = screen.getAllByRole("button", { name: "Resume AI" }).at(-1);
    if (!confirm) throw new Error("resume confirmation required");
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });
    expect(command()).toMatchObject({ mode: "ai", expected_epoch: 2 });
  });
  it("allows emergency pause to supersede a pending resume", async () => {
    current = {
      ...initial,
      epoch: 2,
      desired_mode: "ai",
      worker_mode: "paused",
      status: "pending",
    };
    await mount();
    postResponse = () => {
      current = { ...current, epoch: 3, desired_mode: "paused" };
      return Promise.resolve(reply(current));
    };
    await click("Pause AI");
    expect(command()).toMatchObject({ mode: "paused", expected_epoch: 2 });
    expect(posts()).toHaveLength(1);
  });
  it("checks an uncertain result and only offers an explicit same-key retry", async () => {
    await mount();
    postResponse = () => Promise.reject(new TypeError("fixture network loss"));
    await click("Pause AI");
    expect(screen.getByText(/command result is uncertain/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry the same request" }),
    ).toBeTruthy();
    const original = command();
    postResponse = () => {
      current = {
        ...initial,
        epoch: 1,
        desired_mode: "paused",
        status: "pending",
      };
      return Promise.resolve(reply(current));
    };
    await click("Retry the same request");
    expect(command(1)).toEqual(original);
    expect(posts()).toHaveLength(2);
  });
  it("does not offer retry while status after an uncertain command cannot be read", async () => {
    await mount();
    fetchMock.mockRejectedValue(new TypeError("fixture network loss"));
    await click("Pause AI");
    expect(
      screen.queryByRole("button", { name: "Retry the same request" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });
  it("does not retry an uncertain command when fresh status already advanced", async () => {
    await mount();
    postResponse = () => {
      current = {
        ...initial,
        epoch: 1,
        command_id: "50000000-0000-4000-8000-000000000001",
        desired_mode: "paused",
        status: "pending",
      };
      return Promise.reject(new TypeError("response lost after commit"));
    };
    await click("Pause AI");
    expect(
      screen.queryByRole("button", { name: "Retry the same request" }),
    ).toBeNull();
    expect(
      screen.getByText("Pause requested; waiting for worker acknowledgement."),
    ).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });
  it("aborts pending polling and ignores an old call response after navigation", async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const result = render(
      localized(
        <VoiceAIControls sessionId={sessionId} provider="livekit" active />,
      ),
    );
    const previousSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    const nextId = "40000000-0000-4000-8000-000000000002";
    current = { ...initial, session_id: nextId, can_operate: false };
    await act(async () => {
      result.rerender(
        localized(
          <VoiceAIControls sessionId={nextId} provider="livekit" active />,
        ),
      );
      finish?.(reply(initial));
      await Promise.resolve();
    });
    expect(previousSignal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Pause AI" })).toBeNull();
    expect(screen.getByText(/Read-only access/)).toBeTruthy();
    result.unmount();
    const count = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });
  it("does not poll a hidden page and aborts a bounded request on unmount", async () => {
    await mount();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const count = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(count);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>(() => undefined),
    );
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    const signal = fetchMock.mock.calls.at(-1)?.[1]?.signal;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(signal?.aborted).toBe(true);
  });
  it("removes controls and stops polling when fresh permission is revoked", async () => {
    await mount();
    fetchMock.mockResolvedValue(reply({ error: "Forbidden" }, 403));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByRole("button", { name: "Pause AI" })).toBeNull();
    const count = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(posts()).toHaveLength(0);
  });
  it("aborts an uncertain mutation on unmount without follow-up commands", async () => {
    await mount();
    postResponse = () => new Promise<Response>(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Pause AI" }));
    const signal = posts()[0]?.[1]?.signal;
    cleanup();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(posts()).toHaveLength(1);
  });
  it("shows truthful Hebrew pending status", async () => {
    current = {
      ...initial,
      epoch: 1,
      command_id: "50000000-0000-4000-8000-000000000001",
      desired_mode: "paused",
      status: "pending",
    };
    await mount("he");
    expect(
      screen.getByText("בקשת ההשהיה נרשמה; ממתינים לאישור מרכיב השיחה."),
    ).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
  it("does not claim a command was requested before any durable command exists", async () => {
    current = {
      ...initial,
      status: "pending",
      acknowledged_epoch: null,
      worker_mode: null,
      acknowledged_at: null,
    };
    await mount();
    expect(
      screen.getByText(
        "Waiting for a current worker acknowledgement. No control command is recorded.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Resume requested; waiting for worker acknowledgement.",
      ),
    ).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});
