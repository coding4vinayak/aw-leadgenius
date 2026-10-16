import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { validateBody, eventNames, fieldProblem } from "@/lib/validate";
import { unknownEventsProblem } from "@/lib/webhooks";
import { WEBHOOK_CREATE } from "@/lib/fields";
import crypto from "crypto";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const webhooks = await prisma.webhook.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ webhooks });
}

async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, WEBHOOK_CREATE);
  if (!input.ok) return input.error;

  // `events` is a String column whose comment shows an array and whose only
  // reader (`triggerWebhooks`, `webhooks.ts`) splits on commas. Sending the
  // array the comment describes used to reach Prisma as an array and answer
  // 500; sending one bare name used to store a value that `split(",")`
  // returned unchanged, which worked by luck. Both shapes are accepted now and
  // one form is stored.
  const events = eventNames(body.events);
  if (!events.ok) return events.error;

  // A name this product never emits is a subscription that never fires — the
  // same dead end the dispatcher's missing callers were, arrived at from the
  // other side. The typo is refused here instead of stored silently.
  const unknown = unknownEventsProblem(events.values);
  if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });

  const target = await classifyTarget(input.data.url, "url");
  if (!target.ok) return fieldProblem("url", target.reason);

  const secret = crypto.randomBytes(32).toString("hex");
  const webhook = await prisma.webhook.create({
    data: { workspaceId, url: input.data.url, events: events.values.join(","), secret },
  });
  return NextResponse.json({ ...webhook, secret: secret }, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
