"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Permission } from "@or-on/auth";

const Access = createContext<readonly string[]>([]);
export function AccessProvider({
  permissions,
  children,
}: {
  readonly permissions: readonly string[];
  readonly children: ReactNode;
}) {
  return <Access.Provider value={permissions}>{children}</Access.Provider>;
}
/** Presentation guard only. Server permission checks and PostgreSQL RLS remain authoritative. */
export function useCapability(permission: Permission): boolean {
  return useContext(Access).includes(permission);
}
