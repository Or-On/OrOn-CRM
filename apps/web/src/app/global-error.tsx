"use client";

import { globalErrorMessages } from "../i18n/global-error-messages";

const { en, he } = globalErrorMessages;

export default function GlobalError({ retry }: { readonly retry: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>{`${en.feedback.errorTitle} · Or-On Platform`}</title>
      </head>
      <body
        style={{
          margin: 0,
          background: "#171717",
          color: "#fafafa",
          fontFamily: "Geist, Heebo, system-ui, sans-serif",
        }}
      >
        <main
          style={{
            boxSizing: "border-box",
            display: "grid",
            alignContent: "center",
            gap: "1.25rem",
            margin: "0 auto",
            maxWidth: "46rem",
            minHeight: "100vh",
            padding: "clamp(3rem, 10vw, 8rem) clamp(1.25rem, 5vw, 4rem)",
          }}
        >
          <p
            style={{
              color: "#a3a3a3",
              font: "500 0.75rem/1.2 system-ui, sans-serif",
              letterSpacing: 0,
              margin: 0,
              textTransform: "none",
            }}
          >
            Or-On Platform
          </p>
          <h1
            style={{
              font: "500 clamp(1.875rem, 5vw, 3rem)/1.1 system-ui, sans-serif",
              letterSpacing: "-0.025em",
              margin: 0,
            }}
          >
            {en.feedback.errorTitle}
          </h1>
          <p style={{ color: "#a3a3a3", lineHeight: 1.5, margin: 0 }}>
            {en.feedback.errorDescription}
          </p>
          <section
            dir="rtl"
            lang="he"
            style={{
              borderTop: "1px solid rgb(255 255 255 / 10%)",
              display: "grid",
              gap: "0.5rem",
              paddingTop: "1.25rem",
            }}
          >
            <h2
              style={{
                font: "620 1.25rem/1.3 system-ui, sans-serif",
                margin: 0,
              }}
            >
              {he.feedback.errorTitle}
            </h2>
            <p style={{ color: "#a3a3a3", lineHeight: 1.5, margin: 0 }}>
              {he.feedback.errorDescription}
            </p>
          </section>
          <button
            onClick={retry}
            style={{
              alignItems: "center",
              alignSelf: "start",
              background: "#e5e5e5",
              border: 0,
              borderRadius: "0.375rem",
              color: "#262626",
              cursor: "pointer",
              display: "inline-flex",
              font: "500 0.875rem/1 system-ui, sans-serif",
              justifyContent: "center",
              minHeight: "2.25rem",
              padding: "0.5rem 0.75rem",
            }}
            type="button"
          >
            {en.common.retry} / {he.common.retry}
          </button>
        </main>
      </body>
    </html>
  );
}
