// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmsSecurity } from "../src/features/auth";
import { LoginForm } from "../src/app/login/login-form";
import { localized } from "./localized";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const fetchMock = vi.fn<typeof fetch>();
const challenge = {
  id: "6c8f2b51-63a0-4eca-843f-128c025ac894",
  phoneHint: "••••4567",
};
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function requestBody(request: RequestInit | undefined): unknown {
  if (typeof request?.body !== "string") throw new Error("JSON body required");
  return JSON.parse(request.body) as unknown;
}

beforeEach(() => {
  fetchMock.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "or_on_csrf=; Max-Age=0; path=/";
});

describe("SMS verification forms", () => {
  it.each(["en", "he"] as const)(
    "keeps %s staff sign-in gated until the code succeeds",
    async (locale) => {
      const messages = locale === "he" ? he : en;
      fetchMock
        .mockResolvedValueOnce(response({ smsChallenge: challenge }))
        .mockResolvedValueOnce(response({}, 401))
        .mockResolvedValueOnce(response({ home: "/field-service" }));
      render(localized(<LoginForm />, locale));
      fireEvent.change(screen.getByLabelText(messages.auth.email), {
        target: { value: "fixture@example.invalid" },
      });
      fireEvent.change(screen.getByLabelText(messages.auth.password), {
        target: { value: "fictional-password" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: messages.auth.submit }),
      );
      const code = await screen.findByLabelText(messages.smsVerification.code);
      expect(router.replace).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(messages.auth.password)).toBeNull();
      fireEvent.change(code, { target: { value: "123456" } });
      fireEvent.click(
        screen.getByRole("button", { name: messages.smsVerification.verify }),
      );
      await screen.findByText(messages.smsVerification.failed);
      expect(router.replace).not.toHaveBeenCalled();
      fireEvent.change(code, { target: { value: "654321" } });
      fireEvent.click(
        screen.getByRole("button", { name: messages.smsVerification.verify }),
      );
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith("/field-service"),
      );
      expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/auth/sms");
      expect(requestBody(fetchMock.mock.calls[2]?.[1])).toEqual({
        id: challenge.id,
        code: "654321",
      });
      expect(router.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("requires credentials again when staff restart a challenge", async () => {
    fetchMock.mockResolvedValueOnce(response({ smsChallenge: challenge }));
    render(localized(<LoginForm />));
    fireEvent.change(screen.getByLabelText(en.auth.email), {
      target: { value: "fixture@example.invalid" },
    });
    fireEvent.change(screen.getByLabelText(en.auth.password), {
      target: { value: "fictional-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.auth.submit }));
    await screen.findByLabelText(en.smsVerification.code);
    fireEvent.click(
      screen.getByRole("button", { name: en.smsVerification.restart }),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>(en.auth.password).value,
    ).toBe("");
    expect(screen.queryByLabelText(en.smsVerification.code)).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("enrolls through password and phone, then a CSRF-protected code confirmation", async () => {
    document.cookie = "or_on_csrf=fictional-csrf; path=/";
    fetchMock
      .mockResolvedValueOnce(response({ available: true, phoneHint: null }))
      .mockResolvedValueOnce(response({ challenge }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(
        response({ available: true, phoneHint: challenge.phoneHint }),
      );
    render(localized(<SmsSecurity />));
    fireEvent.change(await screen.findByLabelText(en.smsVerification.phone), {
      target: { value: "+12025550123" },
    });
    fireEvent.change(screen.getByLabelText(en.smsVerification.password), {
      target: { value: "fictional-password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: en.smsVerification.enable }),
    );
    fireEvent.change(await screen.findByLabelText(en.smsVerification.code), {
      target: { value: "654321" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: en.smsVerification.verify }),
    );
    await screen.findByRole("button", { name: en.smsVerification.disable });
    expect(screen.getByText(en.smsVerification.saved)).toBeTruthy();
    const start = fetchMock.mock.calls[1]?.[1];
    expect(start?.headers).toMatchObject({ "x-csrf-token": "fictional-csrf" });
    expect(requestBody(start)).toEqual({
      action: "start",
      purpose: "staff_enrollment",
      phone: "+12025550123",
      password: "fictional-password",
    });
    expect(requestBody(fetchMock.mock.calls[2]?.[1])).toEqual({
      action: "complete",
      purpose: "staff_enrollment",
      id: challenge.id,
      code: "654321",
    });
  });

  it("shows an unavailable provider and a failed status request without offering enrollment", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ available: false, phoneHint: null }),
    );
    const view = render(localized(<SmsSecurity />, "he"));
    await screen.findByText(he.smsVerification.unavailable);
    expect(screen.queryByRole("button")).toBeNull();
    view.unmount();
    fetchMock.mockResolvedValueOnce(response({}, 503));
    render(localized(<SmsSecurity />));
    await screen.findByText(en.smsVerification.failed);
    expect(screen.queryByText(en.smsVerification.loading)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
