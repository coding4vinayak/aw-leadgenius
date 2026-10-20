import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody, fieldProblem } from "@/lib/validate";
import { TEMPLATE_CREATE } from "@/lib/fields";
import { normalizeVariableDeclaration, checkTemplateVariables } from "@/lib/template-vars";
import { subjectProblem } from "@/lib/subject-fit";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const channel = searchParams.get("channel");

  const where: any = { workspaceId };
  if (channel) where.channel = channel;
  const templates = await prisma.template.findMany({ where, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ templates });
}

async function POST_impl(request: Request) {
  const requestBody = await request.json();
  const workspaceId = await authedWorkspaceId(request, requestBody.workspaceId);

  // `body` is NOT NULL with no default and this route never looked at it: a
  // template POSTed without message text answered 500, and the caller got a
  // Prisma stack naming the one field they had actually left out.
  const input = validateBody(requestBody, TEMPLATE_CREATE);
  if (!input.ok) return input.error;

  // The `variables` column was written by this spread and read by nothing: a
  // declaration of `["firstNane"]` was a clean 201 whose typo surfaced as a
  // blank in a prospect's email. It is now normalised to the one shape the
  // renderer can match and checked against the text it claims to describe,
  // so a stored declaration can only ever be a promise the send keeps.
  if ("variables" in input.data) {
    const declared = normalizeVariableDeclaration(input.data.variables);
    if (!declared.ok) return fieldProblem("variables", declared.error);
    input.data.variables = declared.names;
    const problems = checkTemplateVariables(declared.names, [input.data.subject, input.data.body]);
    if (problems.length) return fieldProblem("variables", problems.join("; "));
  }

  // The other half of the row's own meaning: `channel` says who would carry this
  // copy and `subject` says what the carrier reads, and the field table cannot
  // express that one of them decides whether the other is mandatory. A blank
  // subject on an EMAIL template reaches a prospect as "New message"; a subject
  // on a chat template is a line nobody sends. `subject` is named as the field
  // either way because it is the column the rule polices, and the message
  // spells out both ways to fix it.
  const subjectVerdict = subjectProblem({ name: input.data.name, channel: input.data.channel, subject: input.data.subject });
  if (subjectVerdict) return fieldProblem("subject", subjectVerdict);

  const template = await prisma.template.create({ data: { workspaceId, ...input.data } });
  return NextResponse.json(template, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
