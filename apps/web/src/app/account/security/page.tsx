import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { currentPublicSession, SmsSecurity } from "../../../features/auth";

export default async function SecurityPage() {
  if ((await currentPublicSession()) === undefined) redirect("/login");
  const t = await getTranslations("smsVerification");
  return (
    <main className="page page--settings">
      <h1>{t("title")}</h1>
      <SmsSecurity />
    </main>
  );
}
