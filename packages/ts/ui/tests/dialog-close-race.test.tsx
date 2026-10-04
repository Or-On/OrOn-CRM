import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "../src/primitives/dialog.js";

describe("queued native dialog close events", () => {
  const originalShowModal = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "close",
  );
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    });
  });
  afterEach(() => {
    cleanup();
    for (const [name, descriptor] of [
      ["showModal", originalShowModal],
      ["close", originalClose],
    ] as const) {
      if (descriptor)
        Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
  });
  it("keeps a reopened dialog open when an earlier native close event arrives", () => {
    const onClose = vi.fn();
    const props = {
      title: "Edit technician",
      closeLabel: "Close",
      onClose,
      children: "Synthetic",
    };
    const view = render(<Dialog {...props} open />);
    const dialog = view.container.querySelector("dialog");
    if (!dialog) throw new Error("Missing dialog");
    view.rerender(<Dialog {...props} open={false} />);
    expect(dialog.open).toBe(false);
    view.rerender(<Dialog {...props} open />);
    expect(dialog.open).toBe(true);
    // HTML close() queues this event: it can arrive after a new showModal().
    fireEvent(dialog, new Event("close"));
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });
  it("still notifies the owner when the currently open dialog is actually closed", () => {
    const onClose = vi.fn();
    const view = render(
      <Dialog title="Edit" closeLabel="Close" onClose={onClose} open>
        Content
      </Dialog>,
    );
    const dialog = view.container.querySelector("dialog");
    if (!dialog) throw new Error("Missing dialog");
    dialog.close();
    fireEvent(dialog, new Event("close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
