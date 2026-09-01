import type postgres from "postgres";

import { addContactNote, getContact, listContacts } from "./contacts.js";

export const crmToolDescriptors = [
  {
    name: "crm_list_contacts",
    description: "List tenant-scoped CRM contacts",
    mutating: false,
  },
  {
    name: "crm_get_contact",
    description: "Read one tenant-scoped CRM contact",
    mutating: false,
  },
  {
    name: "crm_add_contact_note",
    description: "Add a note after explicit confirmation",
    mutating: true,
  },
] as const;

type CrmToolName = (typeof crmToolDescriptors)[number]["name"];

function stringArgument(
  input: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new TypeError(`${name} is required`);
  return value;
}

export async function executeCrmTool(
  sql: postgres.TransactionSql,
  actorUserId: string,
  name: CrmToolName,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (name === "crm_list_contacts") {
    const query = typeof input.query === "string" ? input.query : undefined;
    return listContacts(sql, query === undefined ? {} : { query });
  }
  if (name === "crm_get_contact") {
    return getContact(sql, stringArgument(input, "contactId"));
  }
  if (input.confirm !== true)
    throw new TypeError("mutating CRM tools require confirm=true");
  return addContactNote(
    sql,
    stringArgument(input, "contactId"),
    actorUserId,
    stringArgument(input, "body"),
  );
}
