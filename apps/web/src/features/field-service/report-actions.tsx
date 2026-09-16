"use client";

import { Button, ConfirmDialog } from "@or-on/ui";
import { ArrowLeft, Download, Printer, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { crmMutation } from "../crm";

export function ReportActions({
  caseId,
  he,
  revisionId,
}: {
  readonly caseId: string;
  readonly he: boolean;
  readonly revisionId: string;
}) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function removeReport() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await crmMutation(
        `/api/field-service/reports/${revisionId}`,
        {},
        { method: "DELETE" },
      );
      setDeleteOpen(false);
      router.replace("/field-service/reports");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : he
            ? "לא ניתן למחוק את הדוח. נסו שוב."
            : "The report could not be deleted. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <nav
        aria-label={he ? "פעולות דוח" : "Report actions"}
        className="service-report-document__actions"
      >
        <Link
          className="or-button or-button--secondary or-button--medium"
          href={`/field-service/cases/${caseId}`}
        >
          <ArrowLeft aria-hidden="true" size={15} />
          {he ? "חזרה לתיק" : "Back to case"}
        </Link>
        <div className="service-report-document__export-actions">
          <Button
            onClick={() => {
              setError(undefined);
              setDeleteOpen(true);
            }}
            variant="danger"
          >
            <Trash2 aria-hidden="true" size={15} />
            {he ? "מחיקת דוח" : "Delete report"}
          </Button>
          <a
            className="or-button or-button--secondary or-button--medium"
            download
            href={`/api/field-service/reports/${revisionId}/export?format=xlsx`}
          >
            <Download aria-hidden="true" size={15} />
            {he ? "הורדת Excel" : "Download Excel"}
          </a>
          <button
            className="or-button or-button--primary or-button--medium"
            onClick={() => window.print()}
            type="button"
          >
            <Printer aria-hidden="true" size={15} />
            {he ? "הדפסה או שמירה כ-PDF" : "Print or save as PDF"}
          </button>
        </div>
      </nav>
      <ConfirmDialog
        busy={pending}
        cancelLabel={he ? "ביטול" : "Cancel"}
        confirmLabel={he ? "מחיקת הדוח" : "Delete report"}
        destructive
        description={
          he
            ? "הדוח וכל הגרסאות שלו יוסרו מתצוגות השירות. לא ניתן לבטל פעולה זו."
            : "The report and all of its versions will be removed from service views. This cannot be undone."
        }
        onCancel={() => {
          if (pending) return;
          setDeleteOpen(false);
          setError(undefined);
        }}
        onConfirm={() => void removeReport()}
        open={deleteOpen}
        title={he ? "למחוק את הדוח?" : "Delete this report?"}
      >
        {error === undefined ? null : (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
