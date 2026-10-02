import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { cookiesFrom, hop, location, pkce, startHarness, type Harness } from "./harness.js";

// The whole MCP authorization round trip, as Claude performs it: discover, register,
// authorize with PKCE, sign in at the identity provider, exchange the code, call /mcp.

let h: Harness;
const CLIENT_REDIRECT = "http://127.0.0.1:9/callback";

before(async () => {
  h = await startHarness();
});
after(async () => h.close());

async function registerWith(redirectUris: string[]): Promise<Response> {
  return fetch(`${h.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

// One client for the whole file. The SDK rate-limits registration to 20 an hour per address, and
// every request here comes from 127.0.0.1; registering per test trips it, which is the limit
// working rather than a fault.
let registered: Promise<{ client_id: string; client_secret?: string }> | undefined;
function register(): Promise<{ client_id: string; client_secret?: string }> {
  registered ??= registerOnce();
  return registered;
}

async function registerOnce(): Promise<{ client_id: string; client_secret?: string }> {
  const response = await fetch(`${h.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

// Runs the browser half up to the point the app answers the identity provider's callback, as
// one browser: cookies set along the way are sent back. Returns that answer -- the consent page
// for an allowed person -- and the cookies.
async function signInAt(clientId: string, challenge: string, email: string): Promise<{ response: Response; cookie: string }> {
  h.idp.nextEmail = email;
  const url = new URL(`${h.base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${h.base}/mcp`,
  }).toString();
  const toIdp = await hop(url.href);
  assert.equal(toIdp.status, 302);
  assert.ok(location(toIdp).startsWith(h.idp.issuer), "authorize goes to the identity provider");
  const cookie = cookiesFrom(toIdp);
  const fromIdp = await hop(location(toIdp));
  assert.equal(fromIdp.status, 302);
  return { response: await hop(location(fromIdp), { headers: { cookie } }), cookie };
}

// The consent token from a consent page.
async function consentToken(page: Response): Promise<string> {
  assert.equal(page.status, 200, "expected the consent page");
  const html = await page.text();
  assert.match(html, /Allow access to QuickBooks\?/);
  return html.match(/name="consent" value="([^"]+)"/)![1].replaceAll("&amp;", "&");
}

async function decide(consent: string, decision: "allow" | "deny", origin = h.base): Promise<Response> {
  return hop(`${h.base}/authorize/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ consent, decision }),
  });
}

// The whole browser half, approving at the end; returns the redirect back to the client.
async function authorize(clientId: string, challenge: string, email: string): Promise<Response> {
  const { response } = await signInAt(clientId, challenge, email);
  if (response.status !== 200) return response;
  return decide(await consentToken(response), "allow");
}

async function token(params: Record<string, string>): Promise<Response> {
  return fetch(`${h.base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

async function mcp(accessToken: string, body: unknown): Promise<Response> {
  return fetch(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function signIn(email: string): Promise<{ access_token: string; refresh_token: string; client_id: string; code: string; verifier: string }> {
  const client = await register();
  const { verifier, challenge } = pkce();
  const back = await authorize(client.client_id, challenge, email);
  assert.equal(back.status, 303, `expected redirect back to the client for ${email}`);
  const target = new URL(location(back));
  assert.equal(target.origin + target.pathname, CLIENT_REDIRECT);
  assert.equal(target.searchParams.get("state"), "client-state");
  const code = target.searchParams.get("code")!;
  const response = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CLIENT_REDIRECT,
  });
  assert.equal(response.status, 200);
  return { ...(await response.json()), client_id: client.client_id, code, verifier };
}

describe("discovery", () => {
  test("an unauthenticated /mcp names its resource metadata", async () => {
    const response = await mcp("", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test("the metadata documents point at this server", async () => {
    const resource = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, `${h.base}/mcp`);
    assert.deepEqual(resource.authorization_servers, [`${h.base}/`]);
    const as = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.authorization_endpoint, `${h.base}/authorize`);
    assert.equal(as.registration_endpoint, `${h.base}/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });
});

describe("an allowed user", () => {
  test("signs in and lists every upstream tool", async () => {
    const tokens = await signIn("Nick@Example.com");
    const init = await mcp(tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    assert.equal(init.status, 200);
    const list = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.status, 200);
    const names = ((await list.json()).result.tools as { name: string }[]).map((t) => t.name);
    assert.equal(names.length, h.upstream.tools.length);
    assert.ok(names.length >= 140, `expected upstream's full tool set, got ${names.length}`);
    assert.ok(names.includes("get_company_info"));
    assert.ok(names.includes("get_profit_and_loss"));
  });

  test("matches a *@domain entry", async () => {
    const tokens = await signIn("bob@team.example.com");
    assert.ok(tokens.access_token);
  });

  test("gets a clear error from a tool while no company is connected", async () => {
    const tokens = await signIn("nick@example.com");
    const call = await mcp(tokens.access_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_company_info", arguments: { params: {} } },
    });
    const result = (await call.json()).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not connected/);
  });

  test("can refresh, and the refreshed token works", async () => {
    const tokens = await signIn("nick@example.com");
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.client_id });
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    const list = await mcp(next.access_token, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal(list.status, 200);
  });
});

describe("refusals", () => {
  test("a client cannot register a redirect to somewhere else", async () => {
    const response = await registerWith(["https://attacker.example/callback"]);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error_description, /not permitted/);
  });

  test("Claude's hosted callback and loopback can register", async () => {
    assert.equal((await registerWith(["https://claude.ai/api/mcp/auth_callback"])).status, 201);
    assert.equal((await registerWith(["http://localhost:53682/callback"])).status, 201);
    assert.equal((await registerWith(["http://127.0.0.1:1/x"])).status, 201);
    assert.equal((await registerWith(["https://claude.ai/api/mcp/auth_callback/../evil"])).status, 400);
    assert.equal((await registerWith(["http://localhost.attacker.example/callback"])).status, 400);
  });

  test("signing in alone issues no code: the person must approve", async () => {
    const client = await register();
    const { response } = await signInAt(client.client_id, pkce().challenge, "nick@example.com");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    const html = await response.text();
    assert.match(html, /test client/);
    assert.match(html, /a program on this computer \(127\.0\.0\.1:9\)/);
  });

  test("denying sends the client access_denied and no code", async () => {
    const client = await register();
    const { response } = await signInAt(client.client_id, pkce().challenge, "nick@example.com");
    const back = await decide(await consentToken(response), "deny");
    const target = new URL(location(back));
    assert.equal(target.searchParams.get("error"), "access_denied");
    assert.equal(target.searchParams.get("code"), null);
    assert.equal(target.searchParams.get("state"), "client-state");
  });

  test("approval cannot be submitted from another site", async () => {
    const client = await register();
    const { response } = await signInAt(client.client_id, pkce().challenge, "nick@example.com");
    const back = await decide(await consentToken(response), "allow", "https://attacker.example");
    assert.equal(back.status, 403);
  });

  test("a sign-in callback replayed into a browser that did not start it is refused", async () => {
    const client = await register();
    h.idp.nextEmail = "nick@example.com";
    const url = new URL(`${h.base}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    }).toString();
    const fromIdp = await hop(location(await hop(url.href)));
    const replayed = await hop(location(fromIdp));
    assert.equal(replayed.status, 400);
    assert.match(await replayed.text(), /different browser/);
  });

  test("someone not on the allowlist is stopped at sign-in and given no code", async () => {
    const client = await register();
    const { response: back } = await signInAt(client.client_id, pkce().challenge, "stranger@elsewhere.example");
    assert.equal(back.status, 403);
    assert.match(await back.text(), /stranger@elsewhere\.example.*not authorized/s);
  });

  test("a subdomain does not match *@domain", async () => {
    const client = await register();
    const { response: back } = await signInAt(client.client_id, pkce().challenge, "someone@sub.team.example.com");
    assert.equal(back.status, 403);
  });

  test("an unverified email address is refused even if it is on the list", async () => {
    h.idp.nextEmailVerified = false;
    try {
      const client = await register();
      const { response: back } = await signInAt(client.client_id, pkce().challenge, "nick@example.com");
      assert.equal(back.status, 502);
    } finally {
      h.idp.nextEmailVerified = true;
    }
  });

  test("an authorization code works once", async () => {
    const tokens = await signIn("nick@example.com");
    const again = await token({
      grant_type: "authorization_code",
      code: tokens.code,
      code_verifier: tokens.verifier,
      client_id: tokens.client_id,
      redirect_uri: CLIENT_REDIRECT,
    });
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error, "invalid_grant");
  });

  test("a wrong PKCE verifier is refused", async () => {
    const client = await register();
    const back = await authorize(client.client_id, pkce().challenge, "nick@example.com");
    const code = new URL(location(back)).searchParams.get("code")!;
    const response = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: pkce().verifier,
      client_id: client.client_id,
      redirect_uri: CLIENT_REDIRECT,
    });
    assert.equal(response.status, 400);
  });

  test("a refresh token is not an access token", async () => {
    const tokens = await signIn("nick@example.com");
    const response = await mcp(tokens.refresh_token, { jsonrpc: "2.0", id: 5, method: "tools/list" });
    assert.equal(response.status, 401);
  });

  test("a tampered access token is refused", async () => {
    const tokens = await signIn("nick@example.com");
    const flipped = tokens.access_token.slice(0, -2) + (tokens.access_token.endsWith("A") ? "BB" : "AA");
    const response = await mcp(flipped, { jsonrpc: "2.0", id: 6, method: "tools/list" });
    assert.equal(response.status, 401);
  });

  test("a client ID that was not issued here is unknown", async () => {
    const url = new URL(`${h.base}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "made-up",
      redirect_uri: CLIENT_REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    }).toString();
    const response = await hop(url.href);
    assert.equal(response.status, 400);
  });

  test("a redirect URI that was not registered is refused", async () => {
    const client = await register();
    const url = new URL(`${h.base}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://attacker.example/callback",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    }).toString();
    const response = await hop(url.href);
    assert.equal(response.status, 400);
  });
});

describe("the web pages", () => {
  test("the pages Intuit asks for are public", async () => {
    for (const page of ["/", "/eula", "/privacy", "/qbo/disconnected"]) {
      const response = await fetch(`${h.base}${page}`);
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    }
    const eula = await (await fetch(`${h.base}/eula`)).text();
    // Every legal particular comes from configuration; none is built in.
    assert.match(eula, /laws of the State of Example/);
    assert.match(eula, /Example County, Example/);
    assert.match(eula, /Example Co LLC/);
    const privacy = await (await fetch(`${h.base}/privacy`)).text();
    assert.match(privacy, /operated by Example Co LLC in Exampleland/);
  });

  test("the referrer policy lets the browser send this site's origin on its own forms", async () => {
    // Under no-referrer, browsers send Origin: null on every form POST and the same-origin check
    // refuses this site's own buttons. A browser is not part of these tests, so pin the policy.
    const policy = (await fetch(`${h.base}/`)).headers.get("referrer-policy");
    assert.ok(policy === "same-origin" || policy === "strict-origin" || policy === "strict-origin-when-cross-origin", policy ?? "none");
  });

  test("a POST whose Origin is null is refused, as a cross-site POST arrives under same-origin", async () => {
    const response = await hop(`${h.base}/logout`, { method: "POST", headers: { origin: "null" } });
    assert.equal(response.status, 403);
  });

  test("the app's name is the configured one, made by Tight Line, with its source linked", async () => {
    for (const page of ["/", "/eula", "/qbo/disconnected"]) {
      const html = await (await fetch(`${h.base}${page}`)).text();
      assert.match(html, /aria-label="Tight Line"/, page);
      assert.match(html, /href="https:\/\/github\.com\/Tight-Line\/ledger-mcp"/, page);
    }
    const home = await (await fetch(`${h.base}/`)).text();
    assert.match(home, /<title>Example Ledger<\/title>/);
  });

  async function webSession(email: string): Promise<string> {
    h.idp.nextEmail = email;
    const toIdp = await hop(`${h.base}/login?next=/qbo/connect`);
    const fromIdp = await hop(location(toIdp));
    const back = await hop(location(fromIdp), { headers: { cookie: cookiesFrom(toIdp) } });
    assert.equal(back.status, 302, `web login for ${email}`);
    assert.equal(location(back), "/qbo/connect");
    const session = back.headers.getSetCookie().find((c) => c.startsWith("ledger_session=")) ?? "";
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Lax/);
    return session.split(";")[0];
  }

  test("connecting QuickBooks requires signing in", async () => {
    const response = await hop(`${h.base}/qbo/connect`);
    assert.equal(response.status, 302);
    assert.equal(location(response), "/login?next=%2Fqbo%2Fconnect");
  });

  test("an administrator is sent to Intuit with this server's callback", async () => {
    const cookie = await webSession("nick@example.com");
    const response = await hop(`${h.base}/qbo/connect`, { headers: { cookie } });
    assert.equal(response.status, 302);
    const intuit = new URL(location(response));
    assert.equal(intuit.hostname, "appcenter.intuit.com");
    assert.equal(intuit.searchParams.get("redirect_uri"), `${h.base}/qbo/callback`);
    assert.equal(intuit.searchParams.get("client_id"), "qbo-client");
    assert.ok(intuit.searchParams.get("state"));
  });

  test("an allowed user who is not an administrator cannot connect or disconnect", async () => {
    const cookie = await webSession("bob@team.example.com");
    const connect = await hop(`${h.base}/qbo/connect`, { headers: { cookie } });
    assert.equal(connect.status, 403);
    const disconnect = await hop(`${h.base}/qbo/disconnect`, { method: "POST", headers: { cookie } });
    assert.equal(disconnect.status, 403);
  });

  test("an Intuit callback whose state was not issued for this session is refused", async () => {
    const cookie = await webSession("nick@example.com");
    const response = await hop(`${h.base}/qbo/callback?code=x&realmId=1&state=forged`, { headers: { cookie } });
    assert.equal(response.status, 400);
  });

  test("a cross-site POST is refused", async () => {
    const cookie = await webSession("nick@example.com");
    const response = await hop(`${h.base}/qbo/disconnect`, {
      method: "POST",
      headers: { cookie, origin: "https://elsewhere.example" },
    });
    assert.equal(response.status, 403);
  });

  test("a ?next= pointing off-site is ignored", async () => {
    h.idp.nextEmail = "nick@example.com";
    const toIdp = await hop(`${h.base}/login?next=//evil.example/`);
    const back = await hop(location(await hop(location(toIdp))), { headers: { cookie: cookiesFrom(toIdp) } });
    assert.equal(location(back), "/");
  });
});
