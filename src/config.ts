import path from "node:path";
import { EmailAllowlist } from "./allowlist.js";

// Everything the server needs, read once from the environment and validated before anything
// listens. A missing or malformed value stops the process with a message naming it, rather
// than surfacing later as a login loop or a 500 on the first tool call.

export interface Config {
  publicUrl: URL;
  port: number;
  sealKey: Buffer;

  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
  };

  // Who may use the MCP endpoint at all, and who may connect or disconnect the QuickBooks
  // company. Separate lists because connecting is a different privilege from using: it
  // decides WHICH company every user's tools act on.
  users: EmailAllowlist;
  admins: EmailAllowlist;

  // Where an MCP client may ask for its authorization code to be sent. See redirect-policy.ts.
  clientRedirects: string[];

  qbo: {
    environment: "production" | "sandbox";
    clientId: string;
    clientSecret: string;
    tokenStorePath: string;
    redirectUri: string;
  };

  // Shown on the public pages, including the EULA and privacy policy. The legal ones have no
  // defaults: a deployment that silently inherited someone else's governing law or hosting
  // location would publish a policy that is untrue, which is worse than not starting.
  site: {
    appName: string;
    operator: string;
    contactEmail: string;
    legalEffectiveDate: string;
    governingLaw: string;
    venue: string;
    hostingLocation: string;
  };

  toolTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = new URL(required(env, "PUBLIC_URL"));
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin with no path, e.g. https://ledger-mcp.example.com");
  }
  const localhost = ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !localhost) {
    throw new Error("PUBLIC_URL must be https (Intuit rejects anything else for production apps)");
  }

  const sealKey = Buffer.from(required(env, "SEAL_KEY"), "base64");
  if (sealKey.length !== 32) {
    throw new Error("SEAL_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }

  const users = new EmailAllowlist(list(env.ALLOWED_EMAILS));
  if (users.size === 0) {
    // Empty means nobody, not everybody. Refusing to start makes that impossible to deploy by
    // accident, where "nobody" would look like a broken login and "everybody" like nothing.
    throw new Error("ALLOWED_EMAILS must name at least one address or *@domain");
  }

  // Admins are named one at a time. A wildcard here would let anyone at the domain point
  // every user's tools at a different QuickBooks company.
  const admins = new EmailAllowlist(list(env.ADMIN_EMAILS), { allowWildcards: false });
  if (admins.size === 0) throw new Error("ADMIN_EMAILS must name at least one address");

  // Claude's hosted connectors, and loopback for local clients such as Claude Code. Without a
  // list, anyone could register a client whose redirect is their own server and phish a code.
  const clientRedirects = list(
    env.CLIENT_REDIRECT_URIS ?? "https://claude.ai/api/mcp/auth_callback,loopback",
  );
  if (clientRedirects.length === 0) throw new Error("CLIENT_REDIRECT_URIS must name at least one redirect");

  const environment = (env.QUICKBOOKS_ENVIRONMENT ?? "production").trim();
  if (environment !== "production" && environment !== "sandbox") {
    throw new Error("QUICKBOOKS_ENVIRONMENT must be production or sandbox");
  }

  const tokenStorePath = required(env, "QUICKBOOKS_TOKEN_STORE_PATH");
  if (!path.isAbsolute(tokenStorePath)) {
    throw new Error("QUICKBOOKS_TOKEN_STORE_PATH must be absolute");
  }

  return {
    publicUrl,
    port: Number(env.PORT ?? 8080),
    sealKey,
    oidc: {
      issuer: (env.OIDC_ISSUER ?? "https://accounts.google.com").trim(),
      clientId: required(env, "OIDC_CLIENT_ID"),
      clientSecret: required(env, "OIDC_CLIENT_SECRET"),
    },
    users,
    admins,
    clientRedirects,
    qbo: {
      environment,
      clientId: required(env, "QUICKBOOKS_CLIENT_ID"),
      clientSecret: required(env, "QUICKBOOKS_CLIENT_SECRET"),
      tokenStorePath,
      redirectUri: new URL("/qbo/callback", publicUrl).href,
    },
    site: {
      // Must not contain Intuit's marks; the Intuit Developer Portal rejects app names that do.
      appName: env.APP_NAME?.trim() || "Ledger Bridge",
      operator: required(env, "OPERATOR_NAME"),
      contactEmail: required(env, "CONTACT_EMAIL"),
      legalEffectiveDate: required(env, "LEGAL_EFFECTIVE_DATE"),
      governingLaw: required(env, "GOVERNING_LAW"),
      venue: required(env, "GOVERNING_VENUE"),
      hostingLocation: required(env, "HOSTING_LOCATION"),
    },
    toolTimeoutMs: Number(env.TOOL_TIMEOUT_MS ?? 120_000),
  };
}
