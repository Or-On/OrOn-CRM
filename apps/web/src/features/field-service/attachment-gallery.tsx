"use client";
import type { ServiceAttachmentSummary } from "@or-on/crm";
import { useLocale } from "next-intl";
import { useState } from "react";
import Image from "next/image";
import { evidenceCategoryLabel } from "./field-service-labels";

function Attachment({ item }: { readonly item: ServiceAttachmentSummary }) {
  const he = useLocale().startsWith("he");
  const [failed, setFailed] = useState(false);
  const label = item.caption ?? evidenceCategoryLabel(item.category, he);
  return (
    <a
      className="service-photo-card"
      href={`/api/field-service/attachments/${item.objectId}`}
      target="_blank"
      rel="noreferrer"
    >
      {/* The private download API authenticates each image request. */}
      {item.contentType.startsWith("image/") && !failed ? (
        <Image
          unoptimized
          width={320}
          height={160}
          src={`/api/field-service/attachments/${item.objectId}`}
          alt={label}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : null}
      <strong>{label}</strong>
      {failed ? (
        <small>
          {he
            ? "התמונה אינה זמינה — פתיחת הקובץ"
            : "Image unavailable — open file"}
        </small>
      ) : null}
    </a>
  );
}
export function AttachmentGallery({
  items,
}: {
  readonly items: readonly ServiceAttachmentSummary[];
}) {
  const he = useLocale().startsWith("he");
  const groups = [
    {
      label: he ? "תמונות הלקוח" : "Customer photos",
      items: items.filter((item) => item.source === "customer"),
    },
    {
      label: he ? "תמונות הטכנאי" : "Technician photos",
      items: items.filter(
        (item) =>
          item.source === "technician" && !item.category.endsWith("_signature"),
      ),
    },
    {
      label: he ? "מסמכים נוספים" : "Other documents",
      items: items.filter(
        (item) => !["customer", "technician"].includes(item.source),
      ),
    },
  ];
  return (
    <div className="service-photo-groups">
      {groups.map((group) => (
        <section key={group.label}>
          <h3>{group.label}</h3>
          {group.items.length ? (
            <div className="service-photo-gallery">
              {group.items.map((item) => (
                <Attachment key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <p>{he ? "טרם הועלו קבצים" : "No files uploaded yet"}</p>
          )}
        </section>
      ))}
    </div>
  );
}
