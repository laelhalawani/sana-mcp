import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectAndRenderConfig,
  isOwnedConfigEntry,
} from "../../src/install/config-formats.js";
import { claudeCodePredecessorEntry } from "../../src/install/clients.js";

const target = {
  command: "/opt/sana mcp",
  args: ["mcp"],
  env: { SANA_PROFILE: "work" },
};

test("full-entry ownership rejects unknown fields", () => {
  assert.equal(
    isOwnedConfigEntry(
      { command: target.command, args: target.args, env: target.env },
      target
    ),
    true
  );
  assert.equal(
    isOwnedConfigEntry(
      {
        command: target.command,
        args: target.args,
        env: target.env,
        routing: "foreign",
      },
      target
    ),
    false
  );
});

test("client-scoped predecessor ownership is exact and remains a register no-op", () => {
  const predecessor = {
    type: "stdio",
    command: target.command,
    args: target.args,
    env: target.env,
  };
  assert.equal(
    isOwnedConfigEntry(
      predecessor,
      target,
      undefined,
      [claudeCodePredecessorEntry],
    ),
    true,
  );
  for (const nearMiss of [
    { ...predecessor, type: "sse" },
    { ...predecessor, args: [] },
    { ...predecessor, extra: true },
    { type: "stdio", command: target.command, args: target.args },
  ]) {
    assert.equal(
      isOwnedConfigEntry(
        nearMiss,
        target,
        undefined,
        [claudeCodePredecessorEntry],
      ),
      false,
    );
  }

  const raw = JSON.stringify({
    mcpServers: { "sana-mcp": predecessor },
  });
  const result = inspectAndRenderConfig(
    {
      format: "json",
      topKey: "mcpServers",
      name: "sana-mcp",
      target,
      operation: "register",
      predecessors: [claudeCodePredecessorEntry],
    },
    raw,
  );
  assert.equal(result.ownership.state, "owned");
  assert.equal(result.after, undefined);
});

test("JSONC preserves comments, foreign keys, CRLF, and final newline count", () => {
  const raw =
    "{\r\n  // retained\r\n  \"foreign\": true,\r\n  \"mcp\": {}\r\n}\r\n\r\n";
  const planned = inspectAndRenderConfig(
    {
      format: "jsonc",
      topKey: "mcp",
      name: "sana-mcp",
      target,
      operation: "register",
    },
    raw
  );
  assert.equal(planned.ownership.state, "absent");
  assert.ok(planned.after?.includes("// retained"));
  assert.ok(planned.after?.includes('"foreign": true'));
  assert.equal(planned.after?.match(/\r\n\r\n$/u)?.[0], "\r\n\r\n");
  assert.equal(planned.after?.replace(/\r\n/gu, "").includes("\n"), false);
});

test("JSON and JSONC reject duplicate keys at any object level", () => {
  for (const format of ["json", "jsonc"] as const)
    assert.throws(() =>
      inspectAndRenderConfig(
        {
          format,
          topKey: "mcpServers",
          name: "sana-mcp",
          target,
          operation: "register",
        },
        '{"mcpServers":{"x":1,"x":2}}'
      )
    );
});

test("TOML preserves unrelated text and removes a complete owned subtree", () => {
  const raw = [
    "# retained",
    'theme = "dark"',
    "",
    '[mcp_servers."sana-mcp"]',
    `command = ${JSON.stringify(target.command)}`,
    'args = ["mcp"]',
    'env = { "SANA_PROFILE" = "work" }',
    "",
    '[mcp_servers."sana-mcp".metadata]',
    'source = "foreign"',
    "",
    "[other]",
    "enabled = true",
    "",
  ].join("\n");
  const withNestedForeign = inspectAndRenderConfig(
    {
      format: "toml",
      name: "sana-mcp",
      target,
      operation: "remove",
    },
    raw
  );
  assert.equal(withNestedForeign.ownership.state, "foreign");

  const owned = raw.replace(
    '\n[mcp_servers."sana-mcp".metadata]\nsource = "foreign"\n',
    ""
  );
  const removal = inspectAndRenderConfig(
    {
      format: "toml",
      name: "sana-mcp",
      target,
      operation: "remove",
    },
    owned
  );
  assert.equal(removal.ownership.state, "owned");
  assert.ok(removal.after?.includes("# retained"));
  assert.ok(removal.after?.includes("[other]"));
  assert.doesNotMatch(removal.after ?? "", /mcp_servers/u);
});

test("last TOML table removal preserves trailing footer comments", () => {
  const raw = [
    'theme = "dark"',
    "",
    '[mcp_servers."sana-mcp"]',
    `command = ${JSON.stringify(target.command)}`,
    'args = ["mcp"]',
    'env = { "SANA_PROFILE" = "work" }',
    "",
    "# Keep this footer for the user.",
    "# It is not part of the managed table.",
    "",
  ].join("\n");
  const removal = inspectAndRenderConfig(
    {
      format: "toml",
      name: "sana-mcp",
      target,
      operation: "remove",
    },
    raw
  );
  assert.equal(removal.ownership.state, "owned");
  assert.match(removal.after ?? "", /Keep this footer/u);
  assert.match(removal.after ?? "", /It is not part/u);
  assert.match(removal.after ?? "", /theme = "dark"/u);
  assert.doesNotMatch(removal.after ?? "", /mcp_servers/u);
});

test("inline TOML remove and add preserve every unrelated byte", () => {
  const owned = `{ command = ${JSON.stringify(
    target.command
  )}, args = ["mcp"], env = { SANA_PROFILE = "work" } }`;
  const foreign = 'foreign  = {command="foreign",args=[  ]}';
  const raw = `# prefix\nmcp_servers = { ${foreign} ,   "sana-mcp" = ${owned}   } # suffix\ntheme = "dark"\n`;
  const removedBytes = `# prefix\nmcp_servers = { ${foreign}    } # suffix\ntheme = "dark"\n`;
  const removal = inspectAndRenderConfig(
    {
      format: "toml",
      name: "sana-mcp",
      target,
      operation: "remove",
    },
    raw
  );
  assert.equal(removal.ownership.state, "owned");
  assert.equal(removal.after, removedBytes);

  const registration = inspectAndRenderConfig(
    {
      format: "toml",
      name: "sana-mcp",
      target,
      operation: "register",
    },
    removedBytes
  );
  assert.equal(registration.ownership.state, "absent");
  const insertedMember =
    '"sana-mcp" = { "command" = "/opt/sana mcp", "args" = ["mcp"], "env" = { "SANA_PROFILE" = "work" } }';
  assert.equal(
    registration.after,
    `# prefix\nmcp_servers = { ${foreign}, ${insertedMember}    } # suffix\ntheme = "dark"\n`
  );
  const roundTrip = inspectAndRenderConfig(
    {
      format: "toml",
      name: "sana-mcp",
      target,
      operation: "register",
    },
    registration.after ?? ""
  );
  assert.equal(roundTrip.ownership.state, "owned");
  assert.equal(roundTrip.after, undefined);
});

test("YAML preserves comments and duplicate names block ownership", () => {
  const raw = [
    "# retained",
    "theme: dark",
    "mcpServers:",
    "  - name: sana-mcp",
    "    type: stdio",
    `    command: "${target.command}"`,
    "    args: [mcp]",
    "    env:",
    "      SANA_PROFILE: work",
    "  - name: sana-mcp",
    "    type: stdio",
    '    command: "other"',
    "    args: []",
    "",
  ].join("\n");
  const result = inspectAndRenderConfig(
    {
      format: "yaml-list",
      name: "sana-mcp",
      target,
      operation: "remove",
    },
    raw
  );
  assert.equal(result.ownership.state, "foreign");
  assert.match(
    result.ownership.state === "foreign" ? result.ownership.reason : "",
    /multiple/u
  );
});
