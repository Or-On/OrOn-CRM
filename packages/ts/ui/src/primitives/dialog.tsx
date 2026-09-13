"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./button";

export interface DialogProps {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly className?: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly showCloseButton?: boolean;
  readonly title: string;
}

export function Dialog({
  children,
  closeLabel,
  className = "",
  description,
  onClose,
  open,
  showCloseButton = true,
  title,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  const backdropPress = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open && returnFocus.current?.isConnected)
        returnFocus.current.focus();
    };
  }, []);

  return (
    <dialog
      aria-describedby={description === undefined ? undefined : descriptionId}
      aria-labelledby={titleId}
      className={`or-dialog ${className}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        backdropPress.current =
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom);
      }}
      onClick={(event) => {
        if (backdropPress.current && event.target === event.currentTarget)
          onClose();
        backdropPress.current = false;
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
        {showCloseButton ? (
          <Button aria-label={closeLabel} onClick={onClose} variant="quiet">
            {closeLabel}
          </Button>
        ) : null}
      </div>
      {children}
    </dialog>
  );
}
