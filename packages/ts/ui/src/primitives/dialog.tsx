"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./button";

export interface DialogProps {
  readonly children: ReactNode;
  readonly description?: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: string;
  readonly closeLabel?: string;
}

export function Dialog({
  children,
  description,
  onClose,
  open,
  title,
  closeLabel = "Close",
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
      onCancel={onClose}
      onClose={onClose}
      ref={dialogRef}
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
