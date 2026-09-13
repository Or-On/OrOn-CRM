"use client";

import type { ReactNode } from "react";

import { Button } from "./button";
import { Dialog } from "./dialog";

export interface ConfirmDialogProps {
  readonly busy?: boolean;
  readonly cancelLabel: string;
  readonly children?: ReactNode;
  readonly confirmDisabled?: boolean;
  readonly confirmLabel: string;
  readonly description?: string;
  readonly destructive?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly title: string;
}

/** A deliberately small confirmation surface with a safe initial focus target. */
export function ConfirmDialog({
  busy = false,
  cancelLabel,
  children,
  confirmDisabled = false,
  confirmLabel,
  description,
  destructive = false,
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  return (
    <Dialog
      className="or-confirm-dialog"
      closeLabel={cancelLabel}
      onClose={onCancel}
      open={open}
      showCloseButton={false}
      title={title}
      {...(description === undefined ? {} : { description })}
    >
      {children === undefined ? null : (
        <div className="or-confirm-dialog__body">{children}</div>
      )}
      <div className="or-confirm-dialog__actions">
        <Button
          data-dialog-initial-focus
          disabled={busy}
          onClick={onCancel}
          variant="secondary"
        >
          {cancelLabel}
        </Button>
        <Button
          busy={busy}
          disabled={confirmDisabled}
          onClick={onConfirm}
          variant={destructive ? "danger" : "primary"}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
