"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./button";

export interface DialogProps {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: string;
}

export function Dialog({
  children,
  closeLabel,
  description,
  onClose,
  open,
  title,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-describedby={description === undefined ? undefined : descriptionId}
      aria-labelledby={titleId}
      className="or-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      ref={dialogRef}
      style={{
        maxBlockSize: "calc(100dvb - 2rem)",
        maxHeight: "calc(100vh - 2rem)",
        maxInlineSize: "calc(100dvi - 2rem)",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      <div className="or-dialog__heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description === undefined ? null : (
            <p id={descriptionId}>{description}</p>
          )}
        </div>
        <Button aria-label={closeLabel} onClick={onClose} variant="quiet">
          {closeLabel}
        </Button>
      </div>
      {children}
    </dialog>
  );
}
