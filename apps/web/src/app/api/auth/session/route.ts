import { NextResponse } from "next/server";

import { currentPublicSession } from "../../../../features/auth";

export async function GET() {
  const session = await currentPublicSession();
  return session === undefined
    ? NextResponse.json({ authenticated: false }, { status: 401 })
    : NextResponse.json({ authenticated: true, session });
}
