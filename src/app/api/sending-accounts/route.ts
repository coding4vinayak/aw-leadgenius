import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { getEmailAccountHealth } from "@/lib/channels/email";
import { validateBody } from "@/lib/validate";
import { SENDING_ACCOUNT_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const accounts = await prisma.sendingAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });

  const withHealth = await Promise.all(accounts.map(async (a) => {
    const health = a.channel === "EMAIL" ? await getEmailAccountHealth(a.id) : { reputation: a.reputationScore, dailySent: 0, bounces: 0, complaints: 0 };
    return { ...a, health };
  }));

  return NextResponse.json({ accounts: withHealth });
}

async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, SENDING_ACCOUNT_CREATE);
  if (!input.ok) return input.error;

  if (input.data.isDefault) {
    await prisma.sendingAccount.updateMany({ where: { workspaceId, channel: input.data.channel, isDefault: true }, data: { isDefault: false } });
  }

  // `dailyLimit: dailyLimit || 100` stood here. Measured at the Prisma call: a
  // text limit was a 500 (`Argument dailyLimit: Invalid value provided.
  // Expected Int, provided String`), and `0` — the value that means "stop
  // sending from this account" — became 100 without a word. The column has its
  // own default of 100 (measured: omitting it stores 100), so leaving the key
  // out is now the only way to ask for the fallback, and 0 is refused for what
  // it is.
  const account = await prisma.sendingAccount.create({
    data: { workspaceId, ...input.data },
  });
  return NextResponse.json(account, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
