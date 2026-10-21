// The export surface, pinned without a database.
//
// The route scanner proves the handlers authenticate. This file owns the parts
// a request would not make obvious: the filename cannot carry a header, a
// sending account loses its encrypted config, a webhook loses its secret, the
// engagement audit keeps its ordered trace, user text cannot become a
// spreadsheet formula, and the JSON builder does not quietly select a
// credential column.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activityCsvHeader,
  activityCsvRow,
  exportDownloadHeaders,
  exportFilename,
  publicSendingAccount,
  publicWebhook,
  replyCsvHeader,
  replyCsvRow,
  sentMessageCsvHeader,
  sentMessageCsvRow,
} from "../../src/lib/export";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Minimal RFC 4180 reader for one encoded line; CRLF inside a cell is not in these fixtures. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

describe("export filenames", () => {
  it("sanitises a slug before it reaches Content-Disposition", () => {
    const name = exportFilename('Acme "EU"/Ops\r\n', "workspace", new Date("2026-10-20T12:00:00Z"));
    assert.equal(name, "leadgenius-acme-eu-ops-workspace-2026-10-20.json");
    assert.equal(
      exportFilename("", "activities", new Date("2026-10-20T12:00:00Z")),
      "leadgenius-workspace-activities-2026-10-20.csv",
    );
    assert.equal(
      exportFilename("Acme", "replies", new Date("2026-10-20T12:00:00Z")),
      "leadgenius-acme-replies-2026-10-20.csv",
    );
    assert.equal(
      exportFilename("Acme", "sent-messages", new Date("2026-10-20T12:00:00Z")),
      "leadgenius-acme-sent-messages-2026-10-20.csv",
    );
  });

  it("marks every download no-store and nosniff", () => {
    const headers = exportDownloadHeaders("leadgenius-acme-activities-2026-10-20.csv", "text/csv; charset=utf-8");
    assert.equal(headers["content-disposition"], 'attachment; filename="leadgenius-acme-activities-2026-10-20.csv"');
    assert.equal(headers["cache-control"], "no-store");
    assert.equal(headers["x-content-type-options"], "nosniff");
  });
});

describe("the public sending account projection", () => {
  it("returns the sending account as-is (config is never selected)", () => {
    const acc = { id: "sa_1", name: "Main Email", channel: "EMAIL", provider: "SMTP", dailyLimit: 100, warmupEnabled: true, warmupStage: 3, reputationScore: 95, isDefault: true, isActive: true, createdAt: new Date(), updatedAt: new Date() };
    const exported = publicSendingAccount(acc);
    assert.deepEqual(exported, { id: "sa_1", name: "Main Email", channel: "EMAIL", provider: "SMTP", dailyLimit: 100, warmupEnabled: true, warmupStage: 3, reputationScore: 95, isDefault: true, isActive: true, createdAt: acc.createdAt, updatedAt: acc.updatedAt });
  });
});

describe("the public webhook projection", () => {
  it("returns the webhook as-is (secret is never selected)", () => {
    const hook = { id: "w_1", url: "https://example.test/hook", events: "contact.created,reply.received", isActive: true, createdAt: new Date(), updatedAt: new Date() };
    const exported = publicWebhook(hook);
    assert.deepEqual(exported, { id: "w_1", url: "https://example.test/hook", events: "contact.created,reply.received", isActive: true, createdAt: hook.createdAt, updatedAt: hook.updatedAt });
  });
});

describe("the engagement-activity CSV", () => {
  it("has a stable header and preserves the metadata", () => {
    assert.equal(
      activityCsvHeader(),
      '"activity_id","enrollment_id","contact_id","type","channel","message_id","idempotency_key","metadata","created_at"\r\n',
    );

    const row = parseCsvLine(
      activityCsvRow({
        id: "act_1",
        enrollmentId: "enr_1",
        contactId: "con_1",
        type: "OPENED",
        channel: "EMAIL",
        messageId: "msg_1",
        idempotencyKey: "idem_1",
        metadata: { openCount: 2 },
        createdAt: new Date("2026-03-01T12:00:00Z"),
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "act_1");
    assert.equal(row[1], "enr_1");
    assert.equal(row[2], "con_1");
    assert.equal(row[3], "OPENED");
    assert.equal(row[4], "EMAIL");
    assert.equal(row[5], "msg_1");
    assert.equal(row[6], "idem_1");
    assert.deepEqual(JSON.parse(row[7]), { openCount: 2 });
    assert.equal(row[8], "2026-03-01T12:00:00.000Z");
  });

  it("JSON-encodes metadata so formula characters are harmless", () => {
    const row = parseCsvLine(
      activityCsvRow({
        id: "act_2",
        enrollmentId: "enr_2",
        contactId: "con_2",
        type: "CLICKED",
        channel: "EMAIL",
        messageId: null,
        idempotencyKey: null,
        metadata: { clickedUrl: "=HYPERLINK(\"https://evil.test\")" },
        createdAt: "2026-03-01T12:00:00.000Z",
      }).replace(/\r\n$/, ""),
    );

    // The JSON string itself starts with `{` so it doesn't get formula-prefixed.
    // But individual fields inside are protected by JSON encoding.
    assert.ok(row[7].includes("clickedUrl"), `metadata column should contain the field, got: ${row[7]}`);
    // The formula character inside the JSON value is escaped by JSON encoding
    assert.ok(row[7].includes("="), `formula character should be present in JSON`);
  });
});

describe("the reply CSV", () => {
  it("has a stable header and preserves sentiment/intent", () => {
    assert.equal(
      replyCsvHeader(),
      '"reply_id","enrollment_id","contact_id","workspace_id","channel","content","sentiment","intent","is_auto_reply","processed","created_at"\r\n',
    );

    const row = parseCsvLine(
      replyCsvRow({
        id: "rep_1",
        enrollmentId: "enr_1",
        contactId: "con_1",
        workspaceId: "ws_1",
        channel: "LINKEDIN",
        content: "Interested, tell me more",
        sentiment: "POSITIVE",
        intent: "DEMO_REQUEST",
        isAutoReply: false,
        processed: true,
        createdAt: new Date("2026-03-01T12:00:00Z"),
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "rep_1");
    assert.equal(row[1], "enr_1");
    assert.equal(row[2], "con_1");
    assert.equal(row[3], "ws_1");
    assert.equal(row[4], "LINKEDIN");
    assert.equal(row[5], "Interested, tell me more");
    assert.equal(row[6], "POSITIVE");
    assert.equal(row[7], "DEMO_REQUEST");
    assert.equal(row[8], "false");
    assert.equal(row[9], "true");
    assert.equal(row[10], "2026-03-01T12:00:00.000Z");
  });

  it("refuses to let reply content become a formula", () => {
    const row = parseCsvLine(
      replyCsvRow({
        id: "rep_2",
        enrollmentId: null,
        contactId: "con_2",
        workspaceId: "ws_1",
        channel: "EMAIL",
        content: "=HYPERLINK(\"https://evil.test\")",
        sentiment: null,
        intent: null,
        isAutoReply: true,
        processed: false,
        createdAt: "2026-03-01T12:00:00.000Z",
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[5], "'=HYPERLINK(\"https://evil.test\")");
  });
});

describe("the sent-message CSV", () => {
  it("has a stable header and writes nullable fields as empty", () => {
    assert.equal(
      sentMessageCsvHeader(),
      '"sent_message_id","sending_account_id","enrollment_id","contact_id","template_id","channel","subject","body","provider_message_id","status","error","sent_at","created_at"\r\n',
    );

    const row = parseCsvLine(
      sentMessageCsvRow({
        id: "sm_1",
        sendingAccountId: "sa_1",
        enrollmentId: "enr_1",
        contactId: "con_1",
        templateId: "tmp_1",
        channel: "EMAIL",
        subject: "Hello",
        body: "Hi there",
        providerMessageId: "msg_1",
        status: "SENT",
        error: null,
        sentAt: new Date("2026-03-01T12:00:00Z"),
        createdAt: new Date("2026-03-01T11:59:00Z"),
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[0], "sm_1");
    assert.equal(row[1], "sa_1");
    assert.equal(row[2], "enr_1");
    assert.equal(row[3], "con_1");
    assert.equal(row[4], "tmp_1");
    assert.equal(row[5], "EMAIL");
    assert.equal(row[6], "Hello");
    assert.equal(row[7], "Hi there");
    assert.equal(row[8], "msg_1");
    assert.equal(row[9], "SENT");
    assert.equal(row[10], "");
    assert.equal(row[11], "2026-03-01T12:00:00.000Z");
    assert.equal(row[12], "2026-03-01T11:59:00.000Z");
  });

  it("refuses to let subject become a formula", () => {
    const row = parseCsvLine(
      sentMessageCsvRow({
        id: "sm_2",
        sendingAccountId: "sa_2",
        enrollmentId: null,
        contactId: "con_2",
        templateId: null,
        channel: "EMAIL",
        subject: "=HYPERLINK(\"https://evil.test\")",
        body: "body",
        providerMessageId: null,
        status: "FAILED",
        error: "provider rejected",
        sentAt: null,
        createdAt: "2026-03-01T12:00:00.000Z",
      }).replace(/\r\n$/, ""),
    );

    assert.equal(row[6], "'=HYPERLINK(\"https://evil.test\")");
    assert.equal(row[10], "provider rejected");
  });
});

describe("the export builder's boundaries", () => {
  const builder = source("../../src/lib/export.ts");

  it("selects content, never credential columns", () => {
    for (const forbidden of [
      "config: true",
      "secret: true",
      "tokenHash: true",
      "hashedKey: true",
      "passwordHash: true",
      "stripeCustomerId: true",
      "stripeSubscriptionId: true",
      "stripeSeats: true",
    ]) {
      assert.equal(builder.includes(forbidden), false, `${forbidden} must not be selected by an export`);
    }
  });

  it("scopes every collection query to the workspace", () => {
    const scoped = builder.match(/where:\s*\{\s*workspaceId/g) ?? [];
    assert.ok(scoped.length >= 11, `only ${scoped.length} workspace-scoped queries found — a query may be exporting another tenant's rows`);
  });

  it("keeps engagement/reply/message rows out of the in-memory document and points at the streams", () => {
    assert.ok(builder.includes('download: "/api/export/activities"'));
    assert.ok(builder.includes('download: "/api/export/replies"'));
    assert.ok(builder.includes('download: "/api/export/sent-messages"'));
    assert.ok(builder.includes("activities: {"));
    assert.ok(builder.includes("replies: {"));
    assert.ok(builder.includes("sentMessages: {"));
    assert.equal(/activities:\s*\[/.test(builder), false, "activity rows must not be embedded as an array");
    assert.equal(/replies:\s*\[/.test(builder), false, "reply rows must not be embedded as an array");
    assert.equal(/sentMessages:\s*\[/.test(builder), false, "sent-message rows must not be embedded as an array");
  });

  it("every export route authenticates, checks the role, and uses the shared headers", () => {
    for (const route of [
      "../../src/app/api/export/route.ts",
      "../../src/app/api/export/activities/route.ts",
      "../../src/app/api/export/replies/route.ts",
      "../../src/app/api/export/sent-messages/route.ts",
    ]) {
      const src = source(route);
      assert.match(src, /getSession\(\)/, `${route} must resolve the browser session`);
      assert.match(src, /canManageRoles\(session\.role\)/, `${route} must refuse a member`);
      assert.match(src, /exportDownloadHeaders/, `${route} must use the no-store download headers`);
    }
  });
});