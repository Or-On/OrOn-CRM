import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { EmailWorkspace, type EmailChannel } from "../../features/email";

export const metadata: Metadata = { title: "Email" };

export default async function EmailPage() {
  try {
    const data = await withCurrentTenant(
      "platform:read",
      async (sql, session) => {
        const rows = await sql<
          {
            id: string;
            provider: string;
            provider_account_id: string | null;
            display_address: string | null;
            status: EmailChannel["status"];
            created_at: Date;
            updated_at: Date;
          }[]
        >`
        SELECT id, provider, provider_account_id, display_address, status,
               created_at, updated_at
        FROM messaging.channels
        WHERE kind = 'email'
        ORDER BY status = 'active' DESC, lower(provider), updated_at DESC, id
      `;
        return {
          tenantName: session.tenant.tenantName,
          channels: rows.map((row): EmailChannel => ({
            id: row.id,
            provider: row.provider,
            providerAccountId: row.provider_account_id,
            displayAddress: row.display_address,
            status: row.status,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          })),
        };
      },
    );

    return (
      <main className="page page--wide">
        <EmailWorkspace {...data} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}
