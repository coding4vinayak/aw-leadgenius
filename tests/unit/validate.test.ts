// N5: a wrong-typed scalar used to be the database's problem, and the database
// answered one of two ways. Measured against this app's own dev.db, through the
// exported handlers, with an otherwise-valid body each time:
//
//   POST /api/contacts          email: 42            500 PrismaClientValidationError
//   POST /api/contacts          customFields: 42     201, a number in a Json column
//   POST /api/campaigns         startDate: 42        201, dated 1970-01-01T00:00:00.042Z
//   POST /api/sequences         channel: "FAX"       201, and no sender ever picks it up
//   POST /api/templates         body omitted         500 "Argument `body` is missing"
//   PATCH /api/sequences/:id    steps: []            500 (a relation, not a column)
//   PATCH /api/contacts/:id     {}                   200 holding an unchanged row
//
// These pin the boundary rules those cases imply. The route-level proof is the
// after-table in improvements §8.12; what belongs here is the engine's own
// contract, because every route in this app is written against it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eventNames, validateBody, validateItems, type Schema } from "../../src/lib/validate";

const body = async (response: Response) => (await response.json()) as { error: string; fields?: Record<string, string> };

const ONE = {
  name: { kind: "text", required: true, max: 20 },
  nickname: { kind: "text", nullable: true },
} satisfies Schema;

describe("a field the route did not declare is not a value it will write", () => {
  it("omits a key the body never mentioned, so PATCH cannot reset it", async () => {
    const result = validateBody({ name: "kept" }, { name: { kind: "text" }, nickname: { kind: "text", nullable: true } });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.data ?? {}), ["name"]);
    assert.equal("nickname" in (result.data ?? {}), false);
  });

  it("refuses a body that is not an object", async () => {
    for (const value of [null, 42, "name", ["a"]]) {
      const result = validateBody(value, ONE);
      assert.equal(result.ok, false, `${JSON.stringify(value)} should not pass`);
      assert.equal(result.error?.status, 400);
    }
  });

  it("names every field that is wrong, in one response", async () => {
    const result = validateBody({ name: 42, nickname: [] }, ONE);
    assert.equal(result.ok, false);
    const payload = await body(result.error!);
    assert.match(payload.error, /name must be text/);
    assert.match(payload.error, /nickname must be text/);
    assert.deepEqual(Object.keys(payload.fields ?? {}).sort(), ["name", "nickname"]);
  });
});

describe("text", () => {
  it("trims, because a padded email defeats the unique index", async () => {
    const result = validateBody({ name: "  Ada  " }, ONE);
    assert.equal(result.ok && result.data.name, "Ada");
  });

  it("refuses blank for a NOT NULL column and clears it for a nullable one", async () => {
    assert.equal((await body(validateBody({ name: "   " }, ONE).error!)).error, "name must be a non-empty string");
    const cleared = validateBody({ name: "x", nickname: "  " }, ONE);
    assert.equal(cleared.ok && cleared.data.nickname, null);
  });

  it("says how long it was", async () => {
    const result = validateBody({ name: "n".repeat(21) }, ONE);
    assert.match((await body(result.error!)).error, /name is 21 characters; at most 20/);
  });

  it("checks shape, not deliverability", async () => {
    const email = { to: { kind: "text", format: "email" } } satisfies Schema;
    for (const good of ["a@b.co", "first.last@x.co.uk", "ada+lead@sub.example.com"]) {
      assert.equal(validateBody({ to: good }, email).ok, true, good);
    }
    // A domain with no dot is refused: nothing here can send to it. Measured
    // against this app's dev.db, 12 of 12 stored addresses already match.
    for (const badValue of ["42", "a b@c.com", "a@", "a@b", "a,b@c.com"]) {
      assert.equal(validateBody({ to: badValue }, email).ok, false, `${badValue} is not an address`);
    }
  });

  it("refuses a URL that is not http(s)", async () => {
    const link = { url: { kind: "text", format: "url" } } satisfies Schema;
    assert.equal(validateBody({ url: "https://x.test/h" }, link).ok, true);
    for (const badValue of ["javascript:alert(1)", "ftp://x.test", "mailto:a@b.co", "/relative"]) {
      assert.equal(validateBody({ url: badValue }, link).ok, false, badValue);
    }
  });
});

describe("numbers and booleans", () => {
  const counts = { n: { kind: "int" }, f: { kind: "number" }, b: { kind: "bool" } } satisfies Schema;

  it("refuses a quoted number rather than coercing it", async () => {
    const result = validateBody({ n: "5" }, counts);
    assert.match((await body(result.error!)).error, /n must be a whole number, got "5" as text/);
  });

  it("keeps int and number apart", () => {
    assert.equal(validateBody({ f: 1.5 }, counts).ok, true);
    assert.equal(validateBody({ n: 1.5 }, counts).ok, false);
  });

  it("refuses NaN and Infinity, which JSON has no word for but a client can send", () => {
    assert.equal(validateBody({ f: null }, counts).ok, false);
    // Through JSON.parse these are unreachable; through a hand-built object
    // (a test harness, an import script) they are, and Prisma takes both.
    assert.equal(validateBody({ f: Number.NaN }, counts).ok, false);
    assert.equal(validateBody({ f: Number.POSITIVE_INFINITY }, counts).ok, false);
  });

  it("will not read a string as a boolean", async () => {
    // `!!isDynamic` — the shape this replaced — made "no" and [] mean true.
    const result = validateBody({ b: "yes" }, counts);
    assert.match((await body(result.error!)).error, /b must be true or false, got a string/);
  });

  it("honours min and max", async () => {
    const bounded = { n: { kind: "int", min: 1, max: 3 } } satisfies Schema;
    assert.equal(validateBody({ n: 0 }, bounded).ok, false);
    assert.match((await body(validateBody({ n: 4 }, bounded).error!)).error, /at most 3/);
  });
});

describe("dates", () => {
  const when = { at: { kind: "date", nullable: true } } satisfies Schema;

  it("refuses the bare number Prisma read as milliseconds since 1970", async () => {
    const result = validateBody({ at: 42 }, when);
    assert.match((await body(result.error!)).error, /at must be an ISO 8601 date string, got a number/);
  });

  it("refuses a string that is not a date, and clears a blank one", () => {
    assert.equal(validateBody({ at: "yesterday-ish" }, when).ok, false);
    assert.equal(validateBody({ at: "" }, when).data?.at, null);
    assert.equal(validateBody({ at: "2026-01-05" }, when).ok, true);
  });

  it("hands the route a Date, not a string", () => {
    const result = validateBody({ at: "2026-01-05T10:00:00.000Z" }, when);
    assert.ok(result.data?.at instanceof Date);
    assert.equal((result.data?.at as Date).toISOString(), "2026-01-05T10:00:00.000Z");
  });
});

describe("the enum a SQLite column cannot enforce", () => {
  const row = { channel: { kind: "enum", values: ["EMAIL", "WHATSAPP"] } } satisfies Schema;

  it("refuses a value outside the set and lists the set", async () => {
    const result = validateBody({ channel: "FAX" }, row);
    assert.match((await body(result.error!)).error, /channel must be one of EMAIL \| WHATSAPP, got "FAX"/);
  });

  it("does not fold case, because the code compares with ===", () => {
    assert.equal(validateBody({ channel: "email" }, row).ok, false);
    assert.equal(validateBody({ channel: "EMAIL" }, row).ok, true);
  });
});

describe("JSON columns", () => {
  const doc = { fields: { kind: "json" } } satisfies Schema;

  it("refuses the scalar a Json column takes without complaint", () => {
    assert.equal(validateBody({ fields: 42 }, doc).ok, false);
    assert.equal(validateBody({ fields: "x" }, doc).ok, false);
    assert.equal(validateBody({ fields: { a: 1 } }, doc).ok, true);
    assert.equal(validateBody({ fields: [1, 2] }, doc).ok, true);
  });

  it("refuses null and says what to send instead", async () => {
    // Prisma writes a NULL into a Json column with its own DbNull sentinel, so
    // a caller's null has no honest translation at this boundary.
    const result = validateBody({ fields: null }, doc);
    assert.match((await body(result.error!)).error, /send \{\} to clear it/);
  });

  it("caps what one request can store", async () => {
    const result = validateBody({ fields: { blob: "x".repeat(2048) } }, { fields: { kind: "json", max: 100 } } satisfies Schema);
    assert.match((await body(result.error!)).error, /bytes of JSON; at most 100/);
  });
});

describe("null", () => {
  it("clears a nullable column and is refused on one that is not", async () => {
    assert.equal(validateBody({ name: "x", nickname: null }, ONE).data?.nickname, null);
    const result = validateBody({ name: "x", nickname: null }, { name: { kind: "text" }, nickname: { kind: "text" } } satisfies Schema);
    assert.equal(result.ok, false);
  });

  it("is not the same as leaving a field out", async () => {
    const absent = validateBody({ name: "x" }, ONE);
    assert.equal(absent.ok && "nickname" in absent.data, false);
    const sent = validateBody({ name: "x", nickname: null }, ONE);
    assert.equal(sent.ok && "nickname" in sent.data, true);
  });
});

describe("PATCH", () => {
  const EDITABLE = { name: { kind: "text", max: 20 }, nickname: { kind: "text", nullable: true } } satisfies Schema;

  it("refuses a body that asks to change nothing", async () => {
    // Measured: `contact.update({ data: {} })` resolves and returns the row
    // untouched, so this request used to be a 200 with nothing behind it.
    const result = validateBody({ foo: 1 }, EDITABLE, { requireWrite: true });
    assert.match((await body(result.error!)).error, /no field to update was sent/);
    assert.equal(validateBody({}, EDITABLE, { requireWrite: true }).ok, false);
    assert.equal(validateBody({ nickname: null }, EDITABLE, { requireWrite: true }).ok, true);
    assert.equal(validateBody({ name: "new" }, EDITABLE, { requireWrite: true }).ok, true);
  });

  it("reports a missing required field ahead of the empty-update rule", async () => {
    // enrollments/:id PATCHes exactly one required field, so the body that
    // sends nothing at all is a missing `status`, not an empty update.
    const result = validateBody({ foo: 1 }, { status: { kind: "enum", required: true, values: ["active", "paused"] } }, { requireWrite: true });
    assert.match((await body(result.error!)).error, /status is required/);
  });
});

describe("a nested array", () => {
  const step = { stepNumber: { kind: "int", required: true }, channel: { kind: "enum", required: true, values: ["EMAIL"] } } satisfies Schema;

  it("says which entry is wrong", async () => {
    const result = validateItems([{ stepNumber: 1, channel: "EMAIL" }, { stepNumber: "2", channel: "EMAIL" }], "stepsConfig", step);
    assert.equal(result.ok, false);
    assert.match((await body(result.error!)).error, /stepsConfig\[1\] stepNumber/);
  });

  it("refuses a non-array and an over-long one", async () => {
    assert.equal(validateItems("x", "stepsConfig", step).ok, false);
    const long = Array.from({ length: 3 }, () => ({ stepNumber: 1, channel: "EMAIL" }));
    assert.match((await body(validateItems(long, "stepsConfig", step, { max: 2 }).error!)).error, /at most 2/);
  });

  it("treats an absent array as empty unless the route needs one", () => {
    assert.equal(validateItems(undefined, "stepsConfig", step).ok, true);
    assert.deepEqual(validateItems(undefined, "stepsConfig", step)?.items, []);
    assert.equal(validateItems(undefined, "stepsConfig", step, { required: true }).ok, false);
  });

  it("refuses an entry that is not an object rather than reading keys off it", async () => {
    const result = validateItems([42], "stepsConfig", step);
    assert.match((await body(result.error!)).error, /stepsConfig\[0\] must be an object/);
  });
});

describe("event names on a String column", () => {
  it("accepts the array the schema comment shows and the comma string the reader splits", () => {
    assert.deepEqual(eventNames(["a.b", "c.d"]).values, ["a.b", "c.d"]);
    assert.deepEqual(eventNames("a.b, c.d").values, ["a.b", "c.d"]);
    assert.deepEqual(eventNames(["a.b", "a.b", ""]).values, ["a.b"]);
  });

  it("refuses the shapes that reach Prisma as an array or nothing at all", async () => {
    assert.match((await body(eventNames([42]).error!)).error, /every event must be text/);
    assert.match((await body(eventNames([]).error!)).error, /at least one event/);
    assert.match((await body(eventNames(undefined).error!)).error, /must be an array/);
    assert.match((await body(eventNames(["two words"]).error!)).error, /letters, digits/);
  });
});
