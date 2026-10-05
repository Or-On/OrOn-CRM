// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRequestForm } from "../src/features/service-request";
import { localized } from "./localized";

const tenant = "11111111-1111-4111-8111-111111111111",
  token = "a".repeat(64);
const details = {
  customerName: "Fictional customer",
  faultDescription: "Fictional door will not open",
  photoRequired: false,
  submitted: false,
  reference: null,
};
const fetcher = vi.fn();
beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/service-request#tenant=${tenant}&token=${token}`,
  );
  fetcher.mockReset().mockResolvedValue(Response.json(details));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function ready(locale: "en" | "he" = "en") {
  const view = render(localized(<ServiceRequestForm />, locale));
  await screen.findByLabelText(locale === "he" ? "שם מלא" : "Full name");
  return view;
}
function complete() {
  fireEvent.change(screen.getByLabelText("Fault location"), {
    target: { value: "Fictional street 12" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
}
function submit() {
  const form = screen
    .getByRole("textbox", { name: "Full name" })
    .closest("form");
  if (!form) throw new Error("Form missing");
  fireEvent.submit(form);
}
describe("public service request form", () => {
  it("shows only the business name returned for the validated link", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ ...details, businessName: "Fictional ProTouch" }),
    );
    await ready();
    expect(screen.getByText("Fictional ProTouch")).toBeTruthy();
    expect(screen.queryByText("Or-On Platform")).toBeNull();
  });
  it("clears private drafts on a new link and ignores an old submission's late receipt", async () => {
    await ready();
    complete();
    let finish: ((value: Response) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    submit();
    fetcher.mockResolvedValueOnce(
      Response.json({ ...details, customerName: "Second fictional customer" }),
    );
    act(() => {
      window.history.replaceState(
        null,
        "",
        `/service-request#tenant=${tenant}&token=${"b".repeat(64)}`,
      );
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Full name").value).toBe(
        "Second fictional customer",
      ),
    );
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Fault location").value,
    ).toBe("");
    expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
    await act(async () => {
      finish?.(Response.json({ reference: "OLD-PRIVATE-RECEIPT" }));
      await Promise.resolve();
    });
    expect(screen.queryByText("OLD-PRIVATE-RECEIPT")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Full name").value).toBe(
      "Second fictional customer",
    );
  });
  it.each(["en", "he"] as const)(
    "loads %s from fragment credentials only and keeps arbitrary fault text editable",
    async (locale) => {
      const { container } = await ready(locale);
      expect(fetcher).toHaveBeenCalledWith(
        "/api/service-request",
        expect.objectContaining({
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Service-Tenant": tenant,
          },
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }),
      );
      expect(container.textContent).not.toContain(token);
      expect(container.querySelector("select")).toBeNull();
      const field = screen.getByLabelText<HTMLTextAreaElement>(
        locale === "he" ? "תיאור התקלה" : "Fault description",
      );
      expect(field.value).toBe(details.faultDescription);
      fireEvent.change(field, {
        target: { value: "Any customer-described fault" },
      });
      expect(field.value).toBe("Any customer-described fault");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it.each([
    `?tenant=${tenant}&token=${token}`,
    `#tenant=${tenant}&token=invalid`,
    `#tenant=${tenant}&token=${token}&token=${token}`,
  ])(
    "does not accept credentials outside a valid unique fragment (%s)",
    async (suffix) => {
      window.history.replaceState(null, "", `/service-request${suffix}`);
      render(localized(<ServiceRequestForm />));
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        expect.stringContaining("unavailable"),
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("never submits until the customer explicitly confirms", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Fault location"), {
      target: { value: "Fictional street 12" },
    });
    submit();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("confirm"),
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("submits multipart details and photos once, then displays the receipt", async () => {
    await ready();
    complete();
    const photo = new File(["fictional"], "fault.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Fault photos"), {
      target: { files: [photo] },
    });
    fetcher.mockResolvedValueOnce(
      Response.json({ reference: "SVC-FICTIONAL-1" }),
    );
    submit();
    submit();
    expect(await screen.findByText("SVC-FICTIONAL-1")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/service-request");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get("customerName")).toBe(details.customerName);
    expect(body.get("faultDescription")).toBe(details.faultDescription);
    expect(body.get("serviceLocation")).toBe("Fictional street 12");
    expect(body.get("confirmed")).toBe("true");
    expect(body.getAll("photos")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Submit request" })).toBeNull();
  });
  it.each([400, 503])(
    "keeps the draft and retries safely after HTTP%s",
    async (status) => {
      await ready();
      complete();
      fetcher.mockResolvedValueOnce(
        Response.json({ error: "private backend details" }, { status }),
      );
      submit();
      await screen.findByRole("alert");
      expect(screen.queryByText("private backend details")).toBeNull();
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("Fault location").value,
      ).toBe("Fictional street 12");
      fetcher.mockResolvedValueOnce(
        Response.json({ reference: "SVC-SAME-RETRY" }),
      );
      submit();
      expect(await screen.findByText("SVC-SAME-RETRY")).toBeTruthy();
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it("shows a prior submitted receipt without offering another submission", async () => {
    fetcher.mockResolvedValue(
      Response.json({ ...details, submitted: true, reference: "SVC-EXISTING" }),
    );
    render(localized(<ServiceRequestForm />));
    expect(await screen.findByText("SVC-EXISTING")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["required", "type", "count", "size"])(
    "rejects invalid photos (%s) before POST",
    async (kind) => {
      fetcher.mockResolvedValue(
        Response.json({ ...details, photoRequired: kind === "required" }),
      );
      await ready();
      complete();
      const photos =
        kind === "required"
          ? []
          : Array.from(
              { length: kind === "count" ? 6 : 1 },
              () =>
                new File(["fictional"], "image", {
                  type: kind === "type" ? "image/svg+xml" : "image/jpeg",
                }),
            );
      if (kind === "size" && photos[0])
        Object.defineProperty(photos[0], "size", {
          value: 20 * 1024 * 1024 + 1,
        });
      const fileInput =
        document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!fileInput) throw new Error("Upload missing");
      fireEvent.change(fileInput, { target: { files: photos } });
      submit();
      await screen.findByRole("alert");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("uses a generic expired-link error without rendering backend text", async () => {
    fetcher.mockResolvedValue(Response.json({ error: token }, { status: 404 }));
    const { container } = render(localized(<ServiceRequestForm />));
    await screen.findByRole("alert");
    expect(container.textContent).not.toContain(token);
  });
  it("retries an initial network failure", async () => {
    fetcher.mockRejectedValueOnce(new Error("Network unavailable"));
    render(localized(<ServiceRequestForm />));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Full name").value).toBe(
        details.customerName,
      ),
    );
  });
});
