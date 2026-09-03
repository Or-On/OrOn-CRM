"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export function ConnectionStatus() {
  const t = useTranslations("feedback");
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline ? (
    <div className="connection-banner" role="status">
      {t("offline")}
    </div>
  ) : null;
}
