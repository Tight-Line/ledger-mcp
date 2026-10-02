import { createRequire } from "node:module";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "./config.js";
import { LedgerOAuthProvider, type PendingAuthorization } from "./oauth-provider.js";
import { RedirectPolicy } from "./redirect-policy.js";
import { pkcePair, randomToken, type OidcClient } from "./oidc.js";
import type { QboConnection } from "./qbo-connection.js";
import { Sealer } from "./seal.js";
import type { ToolDefinition, Upstream } from "./upstream.js";
import * as pages from "./pages.js";

export interface AppDependencies {
  config: Config;
  oidc: OidcClient;
  upstream: Upstream;
  connection: QboConnection;
}

const SESSION_TTL = 12 * 60 * 60;
const LOGIN_TTL = 10 * 60;

// The version MCP clients see, from the one place it is written. dist/src/app.js -> package.json.
const VERSION: string = createRequire(import.meta.url)("../../package.json").version;

// What a sealed login state carries across the round trip to the identity provider. One
// callback serves both kinds of sign-in: an MCP client's authorization request, which ends
// with a code sent back to that client, and a person signing in to this site, which ends
// with a session cookie.
type LoginState =
  | { purpose: "mcp"; nonce: string; verifier: string; pending: PendingAuthorization }
  | { purpose: "web"; nonce: string; verifier: string; next: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Session {
  email: string;
}

interface QboState {
  email: string;
  nonce: string;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

// Only a local path, so a crafted ?next= cannot bounce a fresh session to another site.
function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/";
}

function csp(formAction: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

export function createApp({ config, oidc, upstream, connection }: AppDependencies): express.Express {
  const sealer = new Sealer(config.sealKey);
  const mcpUrl = new URL("/mcp", config.publicUrl);
  const secureCookies = config.publicUrl.protocol === "https:";
  // __Host- prefix: Secure, Path=/, no Domain, so no other name under the parent domain can set
  // or read it. A plain-HTTP local run (tests, localhost) cannot set a __Host- cookie at all, so
  // it uses an unprefixed name.
  const cookieName = secureCookies ? "__Host-ledger_session" : "ledger_session";
  const loginCookieName = secureCookies ? "__Host-ledger_login" : "ledger_login";
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`;

  // The sealed login state proves THIS SERVER started a sign-in, not that this BROWSER did. The
  // nonce also goes into a short-lived cookie, and the callback requires both to agree, so a
  // callback URL from someone else's sign-in cannot be replayed into another person's browser to
  // sign them in as the wrong account.
  function beginLogin(state: DistributiveOmit<LoginState, "verifier">, res: Response): void {
    const pkce = pkcePair();
    res.append("Set-Cookie", `${loginCookieName}=${state.nonce}; ${cookieFlags}; Max-Age=${LOGIN_TTL}`);
    const sealed = sealer.seal<LoginState>("login", { ...state, verifier: pkce.verifier } as LoginState, LOGIN_TTL);
    res.redirect(302, oidc.authorizationUrl({ state: sealed, nonce: state.nonce, codeChallenge: pkce.challenge }));
  }

  const provider = new LedgerOAuthProvider(sealer, config.users, new RedirectPolicy(config.clientRedirects), mcpUrl, (pending, res) =>
    beginLogin({ purpose: "mcp", nonce: randomToken(), pending }, res),
  );

  function sessionOf(req: Request): Session | null {
    const opened = sealer.open<Session>("session", readCookie(req, cookieName));
    if (!opened) return null;
    // The allowlists are consulted on every request here as well, so a removed person's open
    // browser session stops working at the same moment their tokens do.
    const { email } = opened.payload;
    return config.users.allows(email) || config.admins.allows(email) ? opened.payload : null;
  }

  // Lax, not Strict, because the Intuit and identity-provider callbacks are top-level
  // navigations from another site and must arrive with the session attached.
  function setSession(res: Response, email: string): void {
    const value = sealer.seal<Session>("session", { email }, SESSION_TTL);
    res.append("Set-Cookie", `${cookieName}=${value}; ${cookieFlags}; Max-Age=${SESSION_TTL}`);
  }

  function clearSession(res: Response): void {
    res.append("Set-Cookie", `${cookieName}=; ${cookieFlags}; Max-Age=0`);
  }

  function sendPage(res: Response, status: number, html: string): void {
    res.status(status).type("html").send(html);
  }

  // Cross-site POSTs carry no Lax cookie already; this refuses them outright as well, so a
  // state-changing form only works when submitted from a page this server rendered.
  function sameOrigin(req: Request, res: Response, next: NextFunction): void {
    const origin = req.get("origin");
    if (origin && origin !== config.publicUrl.origin) {
      sendPage(res, 403, pages.messagePage(config, "Refused", "That request came from another site.", 403));
      return;
    }
    next();
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const current = sessionOf(req);
    if (!current) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!config.admins.allows(current.email)) {
      sendPage(res, 403, pages.forbiddenPage(config, current.email, "connect or disconnect QuickBooks"));
      return;
    }
    res.locals.email = current.email;
    next();
  }

  // Every upstream tool, wrapped once: refuse cleanly while no company is connected, put a
  // deadline on the call, and log who called what. The log is the only record of which
  // person did what, because every person acts through the same QuickBooks connection.
  const guarded: ToolDefinition[] = upstream.tools.map((tool) => ({
    ...tool,
    handler: async (...args: any[]) => {
      const email = args[1]?.authInfo?.extra?.email ?? "unknown";
      if (!connection.isConnected()) {
        log("tool_call", { email, tool: tool.name, ok: false, reason: "not_connected" });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `QuickBooks Online is not connected. An administrator must connect a company at ${config.publicUrl.origin}/ first.`,
            },
          ],
        };
      }
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          tool.handler(...args),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${config.toolTimeoutMs} ms`)), config.toolTimeoutMs);
          }),
        ]);
        log("tool_call", { email, tool: tool.name, ok: !result?.isError, ms: Date.now() - started });
        return result;
      } catch (error) {
        log("tool_call", { email, tool: tool.name, ok: false, ms: Date.now() - started, error: String(error) });
        return { isError: true, content: [{ type: "text", text: `Error: ${String(error)}` }] };
      } finally {
        clearTimeout(timer);
      }
    },
  }));

  const app = express();
  app.disable("x-powered-by");
  // Reverse proxies in front of this server sit on private addresses. Trusting private hops only
  // means req.ip is the first public address in X-Forwarded-For, which is what the SDK's rate
  // limiters key on -- provided every proxy passes that header on. One that replaces it with its
  // own address makes every client look like that proxy, and the limits become one shared bucket.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // same-origin, NOT no-referrer. Under no-referrer a browser sends `Origin: null` on every
    // form POST, same-site ones included, and sameOrigin() then refuses this server's own
    // Disconnect, Sign out and consent buttons. Under same-origin a same-site POST carries the
    // real origin and a cross-site one still arrives as `null`, which is refused. Measured in a
    // browser on the first deploy; the tests set Origin by hand and could not see it.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", csp("'self'"));
    if (secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  // Liveness only. It does not touch QuickBooks or the identity provider, so an outage of
  // either does not get this pod killed and restarted for nothing.
  app.get("/healthz", (_req, res) => {
    res.type("text").send("ok");
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: config.site.appName,
      serviceDocumentationUrl: config.publicUrl,
    }),
  );

  // --- MCP ------------------------------------------------------------------------------
  // STATELESS: a fresh McpServer and transport per request, no session IDs. Nothing about a
  // conversation lives in this process, so a restart or a second replica breaks nobody's
  // session -- there are none. Registering 145 tools per request costs a few milliseconds.
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.post("/mcp", bearer, express.json({ limit: "25mb" }), async (req, res) => {
    const server = new McpServer({ name: config.site.appName, version: VERSION }, { capabilities: { tools: {} } });
    for (const tool of guarded) upstream.registerTool(server, tool);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log("mcp_error", { error: String(error) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  // No server-initiated stream and no sessions to end, in stateless mode.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", bearer, methodNotAllowed);
  app.delete("/mcp", bearer, methodNotAllowed);

  // --- Sign-in --------------------------------------------------------------------------
  app.get("/login", (req, res) => {
    beginLogin({ purpose: "web", nonce: randomToken(), next: safeNext(req.query.next) }, res);
  });

  app.post("/logout", sameOrigin, (_req, res) => {
    clearSession(res);
    res.redirect(303, "/");
  });

  app.get("/auth/callback", async (req, res) => {
    const opened = sealer.open<LoginState>("login", typeof req.query.state === "string" ? req.query.state : undefined);
    if (!opened) {
      sendPage(res, 400, pages.messagePage(config, "Sign-in expired", "That sign-in link has expired or is invalid. Please start again.", 400));
      return;
    }
    const state = opened.payload;
    const browserNonce = readCookie(req, loginCookieName);
    res.append("Set-Cookie", `${loginCookieName}=; ${cookieFlags}; Max-Age=0`);
    if (!browserNonce || !Sealer.equal(browserNonce, state.nonce)) {
      log("login_browser_mismatch");
      sendPage(res, 400, pages.messagePage(config, "Sign-in not recognized", "That sign-in was started in a different browser, or has expired. Please start again.", 400));
      return;
    }
    if (typeof req.query.error === "string") {
      log("login_refused_by_idp", { error: req.query.error });
      sendPage(res, 403, pages.messagePage(config, "Sign-in cancelled", "Sign-in was cancelled or refused by the identity provider.", 403));
      return;
    }
    let email: string;
    try {
      ({ email } = await oidc.exchange(String(req.query.code ?? ""), state.verifier, state.nonce));
    } catch (error) {
      log("login_failed", { error: String(error) });
      sendPage(res, 502, pages.messagePage(config, "Sign-in failed", "The identity provider did not confirm who you are. Please try again.", 502));
      return;
    }

    if (state.purpose === "mcp") {
      const consent = provider.requestConsent(state.pending, email);
      log("mcp_signin", { email, allowed: Boolean(consent), redirect: new URL(state.pending.redirectUri).origin });
      if (!consent) {
        sendPage(res, 403, pages.forbiddenPage(config, email, "use this server"));
        return;
      }
      // form-action governs where a form submission may REDIRECT, not only where it posts, so
      // under 'self' alone the browser refuses the 303 back to the client and Allow appears to do
      // nothing: the response arrives, nothing follows it. Found on the first real sign-in from
      // Claude Code, whose callback is http://localhost:<port>; tests follow redirects with fetch,
      // which ignores CSP, so they could not see it. Widened on this page only, and only to the
      // one origin this client registered and asked for.
      res.setHeader("Content-Security-Policy", csp(`'self' ${new URL(state.pending.redirectUri).origin}`));
      sendPage(res, 200, pages.consentPage(config, provider.openConsent(consent)!, consent));
      return;
    }

    const allowed = config.users.allows(email) || config.admins.allows(email);
    log("web_login", { email, allowed });
    if (!allowed) {
      sendPage(res, 403, pages.forbiddenPage(config, email, "use this server"));
      return;
    }
    setSession(res, email);
    res.redirect(302, state.next);
  });

  // The consent decision. Same-origin only, and the page cannot be framed (CSP frame-ancestors),
  // so it cannot be clicked on someone's behalf from another site.
  app.post("/authorize/consent", sameOrigin, express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    const consent = provider.openConsent(typeof req.body?.consent === "string" ? req.body.consent : undefined);
    if (!consent) {
      sendPage(res, 400, pages.messagePage(config, "Request expired", "That authorization request has expired. Start again from your assistant.", 400));
      return;
    }
    const redirect = new URL(consent.pending.redirectUri).origin;
    if (req.body?.decision !== "allow") {
      log("mcp_authorize", { email: consent.email, allowed: false, decision: "deny", redirect });
      res.redirect(303, provider.deny(consent));
      return;
    }
    const target = provider.approve(consent);
    log("mcp_authorize", { email: consent.email, allowed: Boolean(target), decision: "allow", redirect });
    if (!target) {
      sendPage(res, 403, pages.forbiddenPage(config, consent.email, "use this server"));
      return;
    }
    res.redirect(303, target);
  });

  // --- Public pages: what Intuit's production checklist asks for -----------------------
  app.get("/", (req, res) => {
    const current = sessionOf(req);
    const viewer = current ? { email: current.email, isAdmin: config.admins.allows(current.email) } : null;
    sendPage(res, 200, pages.homePage(config, viewer, connection.status()));
  });
  app.get("/eula", (_req, res) => sendPage(res, 200, pages.eulaPage(config)));
  app.get("/privacy", (_req, res) => sendPage(res, 200, pages.privacyPage(config)));

  // Intuit's Disconnect URL: where Intuit sends someone after they disconnect this app from
  // inside QuickBooks. A page and nothing more. It is an unauthenticated GET that anyone can
  // load, so it must not change anything; Intuit has already revoked the grant, and the next
  // tool call finds that out for itself.
  app.get("/qbo/disconnected", (_req, res) => sendPage(res, 200, pages.disconnectedPage(config)));

  // --- Connecting the QuickBooks company: administrators only ----------------------------
  // Also Intuit's Connect/Reconnect URL. Reconnecting is the same flow: it replaces the
  // stored grant with a new one, and upstream picks it up on the next call.
  app.get("/qbo/connect", requireAdmin, (_req, res) => {
    const state = sealer.seal<QboState>("qbo-state", { email: res.locals.email, nonce: randomToken() }, LOGIN_TTL);
    res.redirect(302, connection.authorizationUrl(state));
  });

  // Intuit's redirect URI. The state must be one this server sealed, within ten minutes, for
  // the administrator whose session is presenting it -- so a code obtained by somebody else
  // for their own company cannot be delivered here and connected in an admin's name.
  app.get("/qbo/callback", requireAdmin, async (req, res) => {
    const email = res.locals.email as string;
    const opened = sealer.open<QboState>("qbo-state", typeof req.query.state === "string" ? req.query.state : undefined);
    if (!opened || opened.payload.email !== email) {
      sendPage(res, 400, pages.messagePage(config, "Connection expired", "That QuickBooks authorization has expired or was not started here. Please connect again.", 400));
      return;
    }
    if (typeof req.query.error === "string") {
      log("qbo_connect_refused", { email, error: req.query.error });
      sendPage(res, 403, pages.messagePage(config, "Not connected", "QuickBooks authorization was cancelled or refused.", 403));
      return;
    }
    try {
      const status = await connection.complete(req.originalUrl, email);
      log("qbo_connected", { email, realmId: status.realmId, environment: status.environment });
      res.redirect(303, "/");
    } catch (error) {
      log("qbo_connect_failed", { email, error: String(error) });
      sendPage(res, 502, pages.messagePage(config, "Not connected", "Intuit did not complete the authorization. Please try again.", 502));
    }
  });

  app.post("/qbo/disconnect", sameOrigin, requireAdmin, async (_req, res) => {
    const email = res.locals.email as string;
    const { revoked } = await connection.disconnect();
    log("qbo_disconnected", { email, revoked });
    res.redirect(303, "/qbo/disconnected");
  });

  app.use((_req, res) => sendPage(res, 404, pages.messagePage(config, "Not found", "There is nothing at this address.", 404)));

  return app;
}
