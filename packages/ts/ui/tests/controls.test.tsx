import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Combobox,
  Dialog,
  Popover,
  Select,
  SelectInput,
  Tabs,
} from "../src/index.js";
import { popoverPosition } from "../src/primitives/popover.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("select form contracts", () => {
  it("retains required, native change, FormData and reset without synthetic event shims", () => {
    const change = vi.fn();
    const { getByRole, container } = render(
      <form>
        <Select
          id="provider"
          label="Provider"
          name="provider"
          defaultValue=""
          required
          onChange={change}
        >
          <option value="">Choose provider</option>
          <option value="simulator">Simulator</option>
          <option disabled value="real">
            Real unavailable
          </option>
        </Select>
      </form>,
    );
    const select = getByRole("combobox") as HTMLSelectElement;
    const form = container.querySelector("form");
    if (form === null) throw new Error("Fixture form missing");
    expect(select.checkValidity()).toBe(false);
    fireEvent.change(select, { target: { value: "simulator" } });
    expect(change).toHaveBeenCalledOnce();
    expect(new FormData(form).get("provider")).toBe("simulator");
    expect(select.checkValidity()).toBe(true);
    form.reset();
    expect(select.value).toBe("");
  });

  it("preserves disabled fieldset semantics and external help associations in RTL", () => {
    const { getByRole } = render(
      <fieldset disabled dir="rtl">
        <Select
          aria-describedby="external"
          error="נדרש ערך"
          hint="בחירת תפקיד"
          id="role"
          label="תפקיד"
        >
          <option>מנהל</option>
        </Select>
      </fieldset>,
    );
    const select = getByRole("combobox");
    expect(select.matches(":disabled")).toBe(true);
    expect(select.getAttribute("aria-describedby")).toBe(
      "external role-hint role-error",
    );
    expect(select.getAttribute("aria-invalid")).toBe("true");
  });

  it("exposes a label-free primitive for semantically labelled compact consumers", () => {
    const { getByLabelText } = render(
      <SelectInput aria-label="Workspace" defaultValue="a">
        <option value="a">Fictional workspace</option>
      </SelectInput>,
    );
    expect(getByLabelText("Workspace").className).toContain("or-select");
  });
});

describe("shared popover", () => {
  it("opens with semantics, consumes Escape and returns focus to its trigger", () => {
    const parentKey = vi.fn();
    const { getByRole } = render(
      <div onKeyDown={parentKey}>
        <Popover label="Account" trigger="Open account">
          <button>Settings</button>
        </Popover>
      </div>,
    );
    const trigger = getByRole("button", { name: "Account" });
    fireEvent.click(trigger);
    const panel = getByRole("dialog", { name: "Account" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(parentKey).not.toHaveBeenCalled();
  });

  it("outside dismissal does not steal focus from the newly selected control", () => {
    const { getByRole } = render(
      <>
        <Popover label="Account" trigger="Open account">
          <button>Settings</button>
        </Popover>
        <button>Outside</button>
      </>,
    );
    fireEvent.click(getByRole("button", { name: "Account" }));
    const outside = getByRole("button", { name: "Outside" });
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(
      getByRole("button", { name: "Account" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(document.activeElement).toBe(outside);
  });

  it("lets a native select consume its first Escape before dismissing the parent", () => {
    const parentKey = vi.fn();
    const { getByRole } = render(
      <div onKeyDown={parentKey}>
        <Popover label="Account" trigger="Account">
          <select aria-label="Workspace">
            <option>Fictional preview</option>
          </select>
        </Popover>
      </div>,
    );
    const trigger = getByRole("button", { name: "Account" });
    fireEvent.click(trigger);
    const select = getByRole("combobox", { name: "Workspace" });
    const matches = vi
      .spyOn(select, "matches")
      .mockImplementation((selector) => selector === ":open");
    expect(fireEvent.keyDown(select, { key: "Escape" })).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(parentKey).not.toHaveBeenCalled();
    matches.mockReturnValue(false);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("menus support arrows, Home/End, typeahead and direct selection", () => {
    const action = vi.fn();
    const { getByRole, queryByRole } = render(
      <Popover label="Create" trigger="Create" role="menu">
        {({ close }) => (
          <>
            <button role="menuitem">Campaign</button>
            <button
              role="menuitem"
              onClick={() => {
                action();
                close();
              }}
            >
              Contact
            </button>
            <button role="menuitem">Flow</button>
          </>
        )}
      </Popover>,
    );
    fireEvent.click(getByRole("button", { name: "Create" }));
    const first = getByRole("menuitem", { name: "Campaign" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      getByRole("menuitem", { name: "Contact" }),
    );
    fireEvent.keyDown(getByRole("menuitem", { name: "Contact" }), {
      key: "End",
    });
    expect(document.activeElement).toBe(
      getByRole("menuitem", { name: "Flow" }),
    );
    fireEvent.keyDown(getByRole("menuitem", { name: "Flow" }), { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "f" });
    expect(document.activeElement).toBe(
      getByRole("menuitem", { name: "Flow" }),
    );
    fireEvent.click(getByRole("menuitem", { name: "Contact" }));
    expect(action).toHaveBeenCalledOnce();
    expect(queryByRole("menu")).toBeNull();
  });

  it("aligns logical start in RTL and flips above a cramped viewport edge", () => {
    const position = popoverPosition(
      { left: 280, right: 350, top: 700, bottom: 744 },
      { width: 240, height: 300 },
      { width: 390, height: 844 },
      "start",
      true,
    );
    expect(position).toMatchObject({ left: 110, top: 392, origin: "bottom" });
    const narrow = popoverPosition(
      { left: 320, right: 360, top: 12, bottom: 56 },
      { width: 400, height: 250 },
      { width: 360, height: 640 },
      "start",
      false,
    );
    expect(narrow.left).toBe(12);
    expect(narrow.top).toBe(64);
  });
});

describe("searchable entity combobox", () => {
  const options = [
    {
      label: "Fictional Atlas",
      value: "atlas",
      description: "Preview contact",
    },
    { label: "לקוח לדוגמה", value: "hebrew" },
    { label: "Fictional unavailable", value: "unavailable", disabled: true },
  ];

  it("searches actual labels and metadata, submits selected identity and resets the native default", () => {
    const { getByRole, queryByRole, container } = render(
      <form>
        <Combobox
          id="contact"
          label="Contact"
          name="contactId"
          searchLabel="Search contacts"
          emptyLabel="No matching contacts"
          options={options}
        />
      </form>,
    );
    const form = container.querySelector("form");
    if (form === null) throw new Error("Fixture form missing");
    expect(new FormData(form).get("contactId")).toBe("atlas");
    fireEvent.click(getByRole("button", { name: "Contact" }));
    const search = getByRole("combobox", { name: "Search contacts" });
    fireEvent.change(search, { target: { value: "לדוגמה" } });
    expect(getByRole("option", { name: "לקוח לדוגמה" })).toBeTruthy();
    expect(queryByRole("option", { name: "Fictional Atlas" })).toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(new FormData(form).get("contactId")).toBe("hebrew");
    expect(document.activeElement).toBe(
      getByRole("button", { name: "Contact" }),
    );
    act(() => form.reset());
    expect(new FormData(form).get("contactId")).toBe("atlas");
    expect(getByRole("button", { name: "Contact" }).textContent).toContain(
      "Fictional Atlas",
    );
  });

  it("retains selection when a query has no matches and exposes a localized empty state", () => {
    const { getByRole, getByText, container } = render(
      <form>
        <Combobox
          id="contact"
          label="Contact"
          name="contactId"
          searchLabel="Search contacts"
          emptyLabel="No matching contacts"
          options={options}
        />
      </form>,
    );
    fireEvent.click(getByRole("button", { name: "Contact" }));
    const search = getByRole("combobox", { name: "Search contacts" });
    fireEvent.change(search, { target: { value: "does not exist" } });
    expect(getByText("No matching contacts").getAttribute("role")).toBe(
      "status",
    );
    fireEvent.keyDown(search, { key: "Enter" });
    expect(container.querySelector("select")?.value).toBe("atlas");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).toBe(
      getByRole("button", { name: "Contact" }),
    );
  });
});

describe("vertical tabs and modal focus", () => {
  it.each([
    { direction: "ltr" as const, left: 350, right: 450, delta: 150 },
    { direction: "rtl" as const, left: -150, right: -50, delta: -150 },
  ])(
    "reveals the selected horizontal tab in $direction without changing selection or page scroll",
    ({ direction, left, right, delta }) => {
      const change = vi.fn();
      const content = (activeId: string) => (
        <Tabs
          activeId={activeId}
          ariaLabel="Orchestration"
          direction={direction}
          items={[
            { id: "agents", label: "Agents" },
            { id: "handoffs", label: "Handoffs" },
          ]}
          onChange={change}
        />
      );
      const { getByRole, rerender } = render(content("agents"));
      const list = getByRole("tablist");
      const active = getByRole("tab", { name: "Handoffs" });
      const scroll = vi.fn();
      Object.defineProperty(list, "scrollBy", {
        configurable: true,
        value: scroll,
      });
      Object.defineProperty(list, "clientWidth", {
        configurable: true,
        value: 300,
      });
      vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 300,
      } as DOMRect);
      const activeRect = vi
        .spyOn(active, "getBoundingClientRect")
        .mockReturnValue({ left, right } as DOMRect);
      rerender(content("handoffs"));
      expect(scroll).toHaveBeenCalledExactlyOnceWith({
        left: delta,
        top: 0,
        behavior: "auto",
      });
      expect(change).not.toHaveBeenCalled();
      expect(active.getAttribute("aria-selected")).toBe("true");
      expect(active.tabIndex).toBe(0);
      // Returning to an already-visible tab must not scroll either axis.
      scroll.mockClear();
      activeRect.mockReturnValue({ left: 40, right: 140 } as DOMRect);
      rerender(content("agents"));
      rerender(content("handoffs"));
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it("uses block-direction arrows in vertical tabs for both reading directions", () => {
    const change = vi.fn();
    const { getByRole } = render(
      <Tabs
        activeId="account"
        ariaLabel="Settings"
        direction="rtl"
        orientation="vertical"
        items={[
          { id: "account", label: "Account" },
          { id: "team", label: "Team" },
        ]}
        onChange={change}
      />,
    );
    expect(getByRole("tablist").getAttribute("aria-orientation")).toBe(
      "vertical",
    );
    fireEvent.keyDown(getByRole("tab", { name: "Account" }), {
      key: "ArrowDown",
    });
    expect(change).toHaveBeenLastCalledWith("team");
    fireEvent.keyDown(getByRole("tab", { name: "Team" }), { key: "ArrowUp" });
    expect(change).toHaveBeenLastCalledWith("account");
  });

  it("restores the invoking control after a modal closes", () => {
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
    const content = (open: boolean) => (
      <>
        <button>Open form</button>
        <Dialog
          closeLabel="Close"
          open={open}
          onClose={() => undefined}
          title="Form"
        >
          <button data-dialog-initial-focus>Cancel</button>
        </Dialog>
      </>
    );
    const { getByRole, rerender } = render(content(false));
    const opener = getByRole("button", { name: "Open form" });
    opener.focus();
    rerender(content(true));
    expect(document.activeElement).toBe(
      getByRole("button", { name: "Cancel" }),
    );
    rerender(content(false));
    expect(document.activeElement).toBe(opener);
  });
});
