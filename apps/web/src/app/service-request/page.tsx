import type { Metadata } from "next";
import { ServiceRequestForm } from "../../features/service-request";

export const metadata: Metadata = {
  title: { absolute: "פנייה לשירות" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ServiceRequestPage() {
  return <ServiceRequestForm />;
}
