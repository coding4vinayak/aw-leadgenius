import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { buildWorkspaceExport, exportDownloadHeaders, exportFilename } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * GET /api/export — the buyer's copy of the workspace, as one JSON file.
 *
 * Session-gated, not API-key-gated: it contains every campaign, sequence,
 * template, contact, enrollment count, sending account, webhook destination and
 * team member in the workspace. It is a data-rights door for the people who own
 * the account. Owners and admins may take it; a member can run campaigns but
 * cannot walk away with the whole workspace in one request.
 *
 * Engagements, replies and sent messages are the unbounded tables, so they have
 * their own streamed CSV doors and this document names the counts instead of
 * pretending truncated arrays are everything. Secrets are stripped in the
 * builder, not here.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!canManageRoles(session.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can export the workspace." },
      { status: 403 },
    );
  }

  try {
    const exportedAt = new Date();
    const data = await buildWorkspaceExport(session.workspaceId, exportedAt);
    return new NextResponse(JSON.stringify(data, null, 2), {
      status: 200,
      headers: exportDownloadHeaders(
        exportFilename(data.workspace.slug, "workspace", exportedAt),
        "application/json; charset=utf-8",
      ),
    });
  } catch (err) {
    console.error("[export] workspace export failed:", err);
    return NextResponse.json({ error: "Could not build the workspace export." }, { status: 500 });
  }
}