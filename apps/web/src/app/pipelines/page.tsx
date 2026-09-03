import { productMetadata } from "../../i18n/product-metadata";
import { AccessDenied } from "../../i18n/access-denied";
import { ProductHeading } from "../../i18n/product-heading";
import { redirect } from "next/navigation";

import { listPipelineBoards } from "@or-on/crm";

import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { PipelineBoard } from "../../features/pipelines";

export default async function PipelinesPage() {
  try {
    const boards = await withCurrentTenant("crm:read", (sql) =>
      listPipelineBoards(sql),
    );
    return (
      <main className="page page--wide">
        <ProductHeading page="pipelines" />
        <PipelineBoard boards={boards} />
      </main>
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const generateMetadata = () => productMetadata("pipelines");
