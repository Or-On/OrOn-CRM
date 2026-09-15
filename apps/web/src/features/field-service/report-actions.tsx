"use client";

import { ArrowLeft, Download, Printer } from "lucide-react";
import Link from "next/link";

export function ReportActions({
  caseId,
  he,
  revisionId,
}: {
  readonly caseId: string;
  readonly he: boolean;
  readonly revisionId: string;
}) {
  return (
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
  );
}
