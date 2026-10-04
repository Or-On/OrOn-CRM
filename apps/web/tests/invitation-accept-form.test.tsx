// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: state.refresh, replace: state.replace }),
}));

import { AcceptInvitationForm } from "../src/app/invite/accept-form";

describe("invitation acceptance navigation", () => {
  beforeEach(() => {
    state.refresh.mockReset();
    state.replace.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("enters the app as the newly created invited account", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ accountCreated: true, signedIn: true }),
        ),
    );
    render(
      <AcceptInvitationForm existingAccount={false} token={"x".repeat(48)} />,
    );

    fireEvent.change(screen.getByLabelText("displayName"), {
      target: { value: "New Member" },
    });
    fireEvent.change(screen.getByLabelText("password"), {
      target: { value: "a-secure-fictional-password" },
    });
    const form = screen.getByRole("button", { name: "join" }).closest("form");
    if (form === null) throw new Error("Invitation form missing");
    fireEvent.submit(form);

    await waitFor(() => expect(state.replace).toHaveBeenCalledWith("/"));
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("sends an existing invited account to a clean sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ accountCreated: false, signedIn: false }),
        ),
    );
    render(<AcceptInvitationForm existingAccount token={"y".repeat(48)} />);

    const form = screen.getByRole("button", { name: "join" }).closest("form");
    if (form === null) throw new Error("Invitation form missing");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(state.replace).toHaveBeenCalledWith("/login?invitation=accepted"),
    );
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("restores the submit focus after a failed acceptance and blocks repeated pending submission", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", request);
    render(<AcceptInvitationForm existingAccount token={"z".repeat(48)} />);
    const button = screen.getByRole("button", { name: "join" });
    const form = button.closest("form");
    if (form === null) throw new Error("Invitation form missing");
    button.focus();
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(request).toHaveBeenCalledTimes(1);
    button.blur();
    finish(Response.json({ error: "synthetic failure" }, { status: 503 }));
    await waitFor(() => expect(screen.getByText("failed")).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(state.replace).not.toHaveBeenCalled();
  });
});
