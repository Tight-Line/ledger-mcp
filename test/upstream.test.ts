import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHarness, type Harness } from "./harness.js";

// The two places this repo depends on upstream internals, checked against the pinned commit.
// When an upstream bump breaks one of these, this is the test that says so.

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => h.close());

test("every tool upstream registers is loaded, and nothing it leaves out", () => {
  const index = readFileSync(path.join(h.upstream.dist, "index.js"), "utf8");
  const registered = index.split("\n").filter((line) => /^\s*RegisterTool\(server, \w+\);$/.test(line));
  const commented = index.split("\n").filter((line) => /^\s*\/\/\s*RegisterTool\(server, \w+\);/.test(line));
  assert.equal(h.upstream.tools.length, registered.length);
  assert.ok(commented.length > 0, "upstream's commented-out registrations exist and must not be loaded");
  assert.ok(!h.upstream.tools.some((t) => t.name === "list_accounts"));
});

test("every loaded tool registers on an McpServer", () => {
  const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
  for (const tool of h.upstream.tools) h.upstream.registerTool(server, tool);
});

test("credentials handed to the live client are what upstream's client sees", async () => {
  const { quickbooksClient } = await import(pathToFileURL(path.join(h.upstream.dist, "clients", "quickbooks-client.js")).href);
  h.upstream.setCredentials({ refreshToken: "rt", realmId: "123" });
  assert.equal(quickbooksClient.refreshToken, "rt");
  assert.equal(quickbooksClient.realmId, "123");
  h.upstream.setCredentials(null);
  assert.equal(quickbooksClient.refreshToken, undefined);
});

test("upstream can never start its own interactive OAuth flow", async () => {
  const { quickbooksClient } = await import(pathToFileURL(path.join(h.upstream.dist, "clients", "quickbooks-client.js")).href);
  h.upstream.setCredentials(null);
  // With no refresh token, upstream's authenticate() goes straight to startOAuthFlow(), which in
  // sandbox would bind port 8000 and wait for a browser forever.
  const started = Date.now();
  await assert.rejects(quickbooksClient.authenticate(), /administrator must connect it again/);
  assert.ok(Date.now() - started < 1000, "fails at once rather than waiting");
  assert.equal(quickbooksClient.authInFlight, undefined);
});

test("create_attachable cannot read this server's own files", async () => {
  const { resolveLocalFile } = await import(pathToFileURL(path.join(h.upstream.dist, "helpers", "attachable-file-source.js")).href);
  for (const file of ["/etc/hosts", process.env.QUICKBOOKS_TOKEN_STORE_PATH!, path.join(process.env.HOME ?? "/root", ".profile")]) {
    await assert.rejects(resolveLocalFile(file, 1024 * 1024), /outside the allowed base directories|not found/, file);
  }
});
