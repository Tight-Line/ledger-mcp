import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { loadConfig, type Config } from "../src/config.js";

// A real HTTP server for the app, and a fake OpenID Connect provider beside it that signs real
// ID tokens with a real key. Nothing is mocked inside the app: the test drives it over HTTP
// exactly as a browser and an MCP client would, and the only thing faked is the identity
// provider at the far end, which answers as whoever `idp.nextEmail` says.

export interface FakeIdp {
  issuer: string;
  nextEmail: string;
  nextEmailVerified: boolean;
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

export async function startFakeIdp(clientId: string, clientSecret: string): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; email: string; verified: boolean }>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, idp.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
        }),
      );
    } else if (url.pathname === "/jwks") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname === "/authorize") {
      // A user who signs in instantly as nextEmail.
      const code = randomBytes(12).toString("hex");
      codes.set(code, {
        nonce: url.searchParams.get("nonce")!,
        challenge: url.searchParams.get("code_challenge")!,
        redirectUri: url.searchParams.get("redirect_uri")!,
        email: idp.nextEmail,
        verified: idp.nextEmailVerified,
      });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: back.href }).end();
    } else if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifierOk =
        grant && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant.challenge;
      if (
        !grant ||
        !verifierOk ||
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret ||
        form.get("redirect_uri") !== grant.redirectUri
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const idToken = await new SignJWT({ email: grant.email, email_verified: grant.verified, nonce: grant.nonce, name: "Test" })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(idp.issuer)
        .setAudience(clientId)
        .setSubject(grant.email)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: idToken, access_token: "x" }));
    } else {
      res.writeHead(404).end();
    }
  });

  const idp: FakeIdp = {
    issuer: "",
    nextEmail: "",
    nextEmailVerified: true,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  idp.issuer = `http://127.0.0.1:${await listen(server)}`;
  return idp;
}

export interface Harness {
  base: string;
  config: Config;
  idp: FakeIdp;
  upstream: import("../src/upstream.js").Upstream;
  close(): Promise<void>;
}

// One per test file: upstream reads its environment once, when first imported, and node's
// test runner gives each file its own process.
export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const idp = await startFakeIdp("idp-client", "idp-secret");
  const server = http.createServer();
  const port = await listen(server);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ledger-mcp-test-"));

  Object.assign(process.env, {
    PUBLIC_URL: `http://localhost:${port}`,
    SEAL_KEY: randomBytes(32).toString("base64"),
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: "idp-client",
    OIDC_CLIENT_SECRET: "idp-secret",
    ALLOWED_EMAILS: "nick@example.com, *@team.example.com",
    ADMIN_EMAILS: "nick@example.com",
    QUICKBOOKS_CLIENT_ID: "qbo-client",
    QUICKBOOKS_CLIENT_SECRET: "qbo-secret",
    QUICKBOOKS_ENVIRONMENT: "sandbox",
    QUICKBOOKS_TOKEN_STORE_PATH: path.join(dataDir, "qbo-tokens.env"),
    CONTACT_EMAIL: "legal@example.com",
    ...env,
  });

  const config = loadConfig();
  const { loadUpstream, prepareUpstreamEnvironment } = await import("../src/upstream.js");
  const { OidcClient } = await import("../src/oidc.js");
  const { QboConnection } = await import("../src/qbo-connection.js");
  const { createApp } = await import("../src/app.js");

  prepareUpstreamEnvironment(config);
  const upstream = await loadUpstream();
  const oidc = await OidcClient.discover({ ...config.oidc, redirectUri: new URL("/auth/callback", config.publicUrl).href });
  const app = createApp({ config, oidc, upstream, connection: new QboConnection(config, upstream) });
  server.on("request", app);

  return {
    base: config.publicUrl.origin,
    config,
    idp,
    upstream,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await idp.close();
    },
  };
}

// fetch without following redirects, so each hop can be inspected.
export async function hop(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual" });
}

// The cookies a response set, as a Cookie request header.
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

export function location(response: Response): string {
  const value = response.headers.get("location");
  if (!value) throw new Error(`expected a redirect, got ${response.status}: ${value}`);
  return value;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
