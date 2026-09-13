// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderEvaluation } from "../src/features/orchestration";
const api = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("../src/features/crm", () => ({ crmMutation: api.mutate }));
const props = {
  endpoint: "/api/orchestration/agents/fixture",
  versionId: "20000000-0000-4000-8000-000000000001",
  published: true,
  locale: "en",
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("explicit actual model evaluation", () => {
  it("rejects malformed successful responses before rendering timings", async () => {
    api.mutate.mockResolvedValue({
      evaluation: {
        version_id: props.versionId,
        evaluation_kind: "paid_typed_llm",
        model_ms: "bad",
        sources: null,
      },
    });
    render(<AgentProviderEvaluation {...props} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Fixture" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
  });
  it.each(["en", "he"])(
    "discloses cost and sends no automatic %s request",
    (locale) => {
      render(<AgentProviderEvaluation {...props} locale={locale} />);
      expect(api.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole("checkbox").textContent).toBeDefined();
    },
  );
  it("renders only validated answer and measured timings without audio", async () => {
    api.mutate.mockResolvedValue({
      evaluation: {
        version_id: props.versionId,
        request_id: props.versionId,
        agent_id: props.versionId,
        recognized_text: null,
        actions_executed: false,
        evaluation_kind: "paid_typed_llm",
        accepted_text: "When open?",
        response: "Open at nine.",
        decision: "approved_fact",
        sources: [],
        model_ms: 21,
        validation_ms: 2,
        provider: "injected",
        model: "fixture",
        cost_usd: null,
      },
    });
    render(<AgentProviderEvaluation {...props} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "When open?" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Open at nine.");
    expect(screen.getByText("21.0 / 2.0")).toBeDefined();
    expect(document.querySelector("audio")).toBeNull();
    const arguments_ = api.mutate.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { signal: AbortSignal },
    ];
    expect(arguments_[0]).toBe(`${props.endpoint}/provider-evaluate`);
    expect(arguments_[1]).toEqual({
      versionId: props.versionId,
      text: "When open?",
      confirmed: true,
    });
  });
  it("keeps provider failure distinct from deterministic test", async () => {
    api.mutate.mockRejectedValue(new Error("disabled"));
    render(<AgentProviderEvaluation {...props} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Fixture" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("alert");
    expect(document.querySelector("audio")).toBeNull();
  });
});
