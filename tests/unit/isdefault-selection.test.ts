// `isDefault` had a schema index, two routes policing one-per-channel, and no
// reader at all: the flag the operator set decided nothing about who sent.
// This round makes the index honest — the default is tried first — without
// letting it buy an exemption from the cap or the floor.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const engine = source("../../src/lib/sequence-engine.ts");
const selection = /async function selectSendingAccount[\s\S]*?\n\}/.exec(engine)?.[0] ?? "";

describe("isDefault decides the try-order", () => {
  it("the selection function exists to be guarded", () => {
    assert.ok(selection, "selectSendingAccount is defined");
  });

  it("the default is ordered before reputation, and reputation still breaks the rest", () => {
    assert.match(
      selection,
      /orderBy: \[\{ isDefault: "desc" \}, \{ reputationScore: "desc" \}\]/,
    );
  });

  it("priority, not exemption: the return still sits behind cap AND floor", () => {
    assert.match(selection, /if \(spent < cap && account\.reputationScore > REPUTATION_FLOOR\) \{\s*\n\s*return account;/);
    // The loop must not know anything else about the default — no second
    // query, no special branch. One ordered list, one judge.
    assert.doesNotMatch(selection, /isDefault: true/);
    assert.doesNotMatch(selection, /account\.isDefault/);
  });

  it("the candidate list stays the honest one: active, this workspace, this channel", () => {
    assert.match(selection, /where: \{ workspaceId, channel, isActive: true \}/);
  });
});

describe("the routes keep the one-default promise the ordering relies on", () => {
  const create = source("../../src/app/api/sending-accounts/route.ts");
  const patch = source("../../src/app/api/sending-accounts/[id]/route.ts");

  it("creating a default clears the channel's other defaults, scoped to the workspace", () => {
    assert.match(
      create,
      /updateMany\(\{ where: \{ workspaceId, channel: input\.data\.channel, isDefault: true \}, data: \{ isDefault: false \} \}\)/,
    );
  });

  it("patching a default clears siblings on the STORED channel — this route never lets channel move", () => {
    assert.match(
      patch,
      /updateMany\(\{ where: \{ workspaceId: _owned\.workspaceId, channel: _owned\.channel, isDefault: true \}, data: \{ isDefault: false \} \}\)/,
    );
  });

  it("the field tables still accept the flag on both doors (and nothing writes it elsewhere)", () => {
    const fields = source("../../src/lib/fields.ts");
    const createTable = /SENDING_ACCOUNT_CREATE = \{[\s\S]*?\n\}/.exec(fields)?.[0] ?? "";
    const patchTable = /SENDING_ACCOUNT_PATCH = \{[\s\S]*?\n\}/.exec(fields)?.[0] ?? "";
    assert.match(createTable, /isDefault: \{ kind: "bool" \}/);
    assert.match(patchTable, /isDefault: \{ kind: "bool" \}/);
  });
});
