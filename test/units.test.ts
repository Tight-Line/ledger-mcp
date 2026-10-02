import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { EmailAllowlist } from "../src/allowlist.js";
import { GRANT_TTL, LedgerOAuthProvider, type PendingAuthorization } from "../src/oauth-provider.js";
import { RedirectPolicy } from "../src/redirect-policy.js";
import { Sealer } from "../src/seal.js";

describe("EmailAllowlist", () => {
  test("exact addresses, case-insensitively", () => {
    const list = new EmailAllowlist(["Alice.Smith@Ledger.Example"]);
    assert.ok(list.allows("alice.smith@ledger.example"));
    assert.ok(list.allows(" ALICE.SMITH@ledger.example "));
    assert.ok(!list.allows("alice.smith@ledger.example.evil.example"));
    assert.ok(!list.allows("xalice.smith@ledger.example"));
  });

  test("*@domain matches that domain only", () => {
    const list = new EmailAllowlist(["*@ledger.example"]);
    assert.ok(list.allows("anyone@ledger.example"));
    assert.ok(!list.allows("anyone@sub.ledger.example"));
    assert.ok(!list.allows("anyone@ledger.example.evil.example"));
    assert.ok(!list.allows("anyone@evilledger.example"));
  });

  test("entries that could not mean what they look like are rejected at construction", () => {
    for (const bad of ["*", "*@*", "*.ledger.example", "@ledger.example", "nick", "*@com", "a*@x.com"]) {
      assert.throws(() => new EmailAllowlist([bad]), /not an email address/, bad);
    }
  });

  test("wildcards can be forbidden", () => {
    assert.throws(() => new EmailAllowlist(["*@ledger.example"], { allowWildcards: false }));
  });

  test("nothing matches junk", () => {
    const list = new EmailAllowlist(["*@x.com"]);
    for (const junk of [undefined, null, "", "@x.com", "a@b@x.com"]) assert.ok(!list.allows(junk as string));
  });
});

describe("Sealer", () => {
  const sealer = new Sealer(randomBytes(32));

  test("round trips", () => {
    const token = sealer.seal("access", { email: "a@b.com" }, 60);
    assert.deepEqual(sealer.open("access", token)?.payload, { email: "a@b.com" });
  });

  test("a token of one kind is not a token of another", () => {
    const token = sealer.seal("refresh", { email: "a@b.com" }, 60);
    assert.equal(sealer.open("access", token), null);
  });

  test("expired tokens do not open", () => {
    const token = sealer.seal("access", { email: "a@b.com" }, -1);
    assert.equal(sealer.open("access", token), null);
  });

  test("another key's tokens do not open", () => {
    const token = new Sealer(randomBytes(32)).seal("access", { email: "a@b.com" }, 60);
    assert.equal(sealer.open("access", token), null);
  });

  test("every single-byte change is detected", () => {
    const raw = Buffer.from(sealer.seal("session", { email: "a@b.com" }, 60), "base64url");
    for (let i = 0; i < raw.length; i++) {
      const copy = Buffer.from(raw);
      copy[i] ^= 0x01;
      assert.equal(sealer.open("session", copy.toString("base64url")), null, `byte ${i}`);
    }
  });

  test("garbage does not throw", () => {
    for (const junk of ["", "x", "!!!", "a".repeat(5000)]) assert.equal(sealer.open("access", junk), null);
  });
});

describe("LedgerOAuthProvider", () => {
  const key = randomBytes(32);
  const resource = new URL("https://ledger.example/mcp");
  const noLogin = () => {
    throw new Error("not used");
  };

  const make = (emails: string[]) =>
    new LedgerOAuthProvider(new Sealer(key), new EmailAllowlist(emails), new RedirectPolicy(["https://c.example/cb"]), resource, noLogin);

  // Sign-in, consent and approval, without the HTTP around them.
  function approve(provider: LedgerOAuthProvider, pending: PendingAuthorization, email: string): string | null {
    const token = provider.requestConsent(pending, email);
    return token ? provider.approve(provider.openConsent(token)!) : null;
  }

  async function tokensFor(email: string, provider: LedgerOAuthProvider) {
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://c.example/cb"], token_endpoint_auth_method: "none" });
    const redirect = approve(
      provider,
      { clientId: client.client_id, redirectUri: "https://c.example/cb", codeChallenge: "c", scopes: [], resource: resource.href },
      email,
    );
    const code = new URL(redirect!).searchParams.get("code")!;
    return { client, tokens: await provider.exchangeAuthorizationCode(client, code, undefined, "https://c.example/cb", resource) };
  }

  test("removing someone from the allowlist ends their access at the next request", async () => {
    const before = make(["a@x.com", "b@x.com"]);
    const { client, tokens } = await tokensFor("b@x.com", before);
    const info = await before.verifyAccessToken(tokens.access_token);
    assert.equal(info.extra?.email, "b@x.com");

    // Same key, so the token is still cryptographically valid; only the list changed.
    const after = make(["a@x.com"]);
    await assert.rejects(after.verifyAccessToken(tokens.access_token), /no longer authorized/);
    await assert.rejects(after.exchangeRefreshToken(client, tokens.refresh_token!), /no longer authorized/);
  });

  test("a code is bound to the client it was issued to", async () => {
    const provider = make(["a@x.com"]);
    const { client } = await tokensFor("a@x.com", provider);
    const other = await provider.clientsStore.registerClient!({ redirect_uris: ["https://c.example/cb"], token_endpoint_auth_method: "none" });
    const redirect = approve(
      provider,
      { clientId: client.client_id, redirectUri: "https://c.example/cb", codeChallenge: "c", scopes: [] },
      "a@x.com",
    );
    const code = new URL(redirect!).searchParams.get("code")!;
    await assert.rejects(provider.exchangeAuthorizationCode(other, code), /invalid authorization code/);
  });

  test("a refresh cannot widen scopes", async () => {
    const provider = make(["a@x.com"]);
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://c.example/cb"], token_endpoint_auth_method: "none" });
    const redirect = approve(
      provider,
      { clientId: client.client_id, redirectUri: "https://c.example/cb", codeChallenge: "c", scopes: ["read"] },
      "a@x.com",
    );
    const tokens = await provider.exchangeAuthorizationCode(client, new URL(redirect!).searchParams.get("code")!);
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ["read", "admin"]);
    assert.equal(refreshed.scope, "read");
  });

  test("refreshing never extends a sign-in past its absolute limit", async () => {
    const provider = make(["a@x.com"]);
    const { client, tokens } = await tokensFor("a@x.com", provider);
    const realNow = Date.now;
    try {
      // Refresh every 20 days, as a well-behaved client would; the 30-day refresh window alone
      // would let this go on forever.
      let refresh = tokens.refresh_token!;
      for (let day = 20; day < 90; day += 20) {
        Date.now = () => realNow() + day * 86_400_000;
        refresh = (await provider.exchangeRefreshToken(client, refresh)).refresh_token!;
      }
      Date.now = () => realNow() + (GRANT_TTL + 60) * 1000;
      await assert.rejects(provider.exchangeRefreshToken(client, refresh));
    } finally {
      Date.now = realNow;
    }
  });

  test("registration refuses redirects outside the policy", async () => {
    const provider = make(["a@x.com"]);
    await assert.rejects(
      Promise.resolve().then(() => provider.clientsStore.registerClient!({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" })),
      /not permitted/,
    );
  });

  test("a confidential client gets a stable derived secret", async () => {
    const provider = make(["a@x.com"]);
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://c.example/cb"], token_endpoint_auth_method: "client_secret_post" });
    assert.ok(client.client_secret);
    assert.equal(client.client_secret_expires_at, 0);
    const again = await provider.clientsStore.getClient(client.client_id);
    assert.equal(again?.client_secret, client.client_secret);
  });
});
