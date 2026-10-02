import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { EmailAllowlist } from "./allowlist.js";
import type { RedirectPolicy } from "./redirect-policy.js";
import type { Sealer } from "./seal.js";

// The OAuth 2.1 authorization server MCP clients talk to: Claude, Claude Code, MCP Inspector,
// anything that follows the MCP authorization spec. It does dynamic client registration and
// PKCE through the SDK's router, and delegates the one question that matters -- who is this
// -- to the OpenID Connect provider via `beginLogin`.
//
// STATELESS: every value it issues is sealed (see seal.ts). The single exception is a short
// in-memory record of authorization codes already redeemed, which is what makes a code
// single-use; it lives as long as the code does and is lost harmlessly on restart, since an
// unredeemed code from before the restart has at most five minutes left.

export const ACCESS_TOKEN_TTL = 60 * 60;
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL = 5 * 60;
export const CONSENT_TTL = 10 * 60;
// The absolute life of one sign-in. Refreshing renews the refresh token but never past this, so
// a token copied today stops working within 90 days however diligently it is used, and the
// person signs in again.
export const GRANT_TTL = 90 * 24 * 60 * 60;

// What a sealed client ID carries. Only the metadata this server acts on; the rest of what a
// client registers (logo, policy URIs and so on) is display material nobody here displays.
interface ClientPayload {
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  scope?: string;
  iat: number;
}

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
}

interface CodePayload extends PendingAuthorization {
  email: string;
}

// What the consent page carries between showing the request and the person approving it.
export interface ConsentRequest {
  pending: PendingAuthorization;
  email: string;
  clientName?: string;
}

interface TokenPayload {
  email: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  grantExpiresAt: number;
}

export class LedgerOAuthProvider implements OAuthServerProvider {
  private readonly redeemed = new Map<string, number>();

  constructor(
    private readonly sealer: Sealer,
    private readonly users: EmailAllowlist,
    private readonly redirects: RedirectPolicy,
    private readonly resourceUrl: URL,
    // Sends the browser to the identity provider. The provider's callback finishes the job by
    // calling `completeAuthorization` with the verified email.
    private readonly beginLogin: (pending: PendingAuthorization, res: Response) => void,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  private getClient(clientId: string): OAuthClientInformationFull | undefined {
    const opened = this.sealer.open<ClientPayload>("client", clientId);
    if (!opened) return undefined;
    const { iat, ...metadata } = opened.payload;
    const isPublic = metadata.token_endpoint_auth_method === "none";
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: iat,
      ...(isPublic ? {} : { client_secret: this.sealer.derive("client-secret", clientId), client_secret_expires_at: 0 }),
    };
  }

  private registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const refused = client.redirect_uris.filter((uri) => !this.redirects.allows(uri));
    if (refused.length > 0) {
      throw new InvalidClientMetadataError(`redirect_uri not permitted by this server: ${refused.join(", ")}`);
    }
    const payload: ClientPayload = {
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: client.grant_types,
      response_types: client.response_types,
      client_name: client.client_name,
      scope: client.scope,
      iat: Math.floor(Date.now() / 1000),
    };
    // The SDK generated a random ID and secret before calling this; both are replaced. The ID
    // becomes the sealed metadata and the secret is derived from it, so neither is stored.
    const clientId = this.sealer.seal<ClientPayload>("client", payload);
    return this.getClient(clientId)!;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Checked again here, not only at registration, so narrowing the policy also stops clients
    // registered before the change.
    if (!this.redirects.allows(params.redirectUri)) {
      throw new InvalidRequestError("redirect_uri not permitted by this server");
    }
    this.beginLogin(
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        resource: params.resource?.href,
      },
      res,
    );
  }

  // Called once the identity provider has vouched for `email`. Returns a sealed consent request
  // for the page that asks the person to approve, or null if they are not allowed at all.
  //
  // CONSENT IS NOT A FORMALITY HERE. Signing in proves who the person is, not that they meant to
  // hand this client their books: an /authorize link can be sent to anyone, and without this step
  // the only thing they would see is Google's account chooser.
  requestConsent(pending: PendingAuthorization, email: string): string | null {
    if (!this.users.allows(email)) return null;
    const client = this.getClient(pending.clientId);
    if (!client) return null;
    return this.sealer.seal<ConsentRequest>("consent", { pending, email, clientName: client.client_name }, CONSENT_TTL);
  }

  openConsent(token: string | undefined): ConsentRequest | null {
    return this.sealer.open<ConsentRequest>("consent", token)?.payload ?? null;
  }

  // The person approved: send the browser back to the client with a code.
  approve(consent: ConsentRequest): string | null {
    if (!this.users.allows(consent.email)) return null;
    const code = this.sealer.seal<CodePayload>("code", { ...consent.pending, email: consent.email }, AUTHORIZATION_CODE_TTL);
    return this.redirectBack(consent.pending, { code });
  }

  // The person declined: tell the client so, as OAuth specifies.
  deny(consent: ConsentRequest): string {
    return this.redirectBack(consent.pending, { error: "access_denied" });
  }

  private redirectBack(pending: PendingAuthorization, params: Record<string, string>): string {
    const target = new URL(pending.redirectUri);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    if (pending.state !== undefined) target.searchParams.set("state", pending.state);
    return target.href;
  }

  private openCode(client: OAuthClientInformationFull, code: string): CodePayload {
    const opened = this.sealer.open<CodePayload>("code", code);
    if (!opened || opened.payload.clientId !== client.client_id) {
      throw new InvalidGrantError("invalid authorization code");
    }
    return opened.payload;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // The SDK has already checked the PKCE verifier against challengeForAuthorizationCode.
    const payload = this.openCode(client, code);
    if (redirectUri !== undefined && redirectUri !== payload.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && payload.resource && resource.href !== payload.resource) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }
    this.redeem(code);
    if (!this.users.allows(payload.email)) throw new InvalidGrantError("this account is not authorized");
    return this.issue({
      email: payload.email,
      clientId: client.client_id,
      scopes: payload.scopes,
      resource: payload.resource,
      grantExpiresAt: Math.floor(Date.now() / 1000) + GRANT_TTL,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const opened = this.sealer.open<TokenPayload>("refresh", refreshToken);
    if (!opened || opened.payload.clientId !== client.client_id) {
      throw new InvalidGrantError("invalid refresh token");
    }
    const payload = opened.payload;
    // Checked again here, and on every access token use, so that removing someone from the
    // allowlist ends their access at their next request rather than when a token expires.
    if (!this.users.allows(payload.email)) throw new InvalidGrantError("this account is no longer authorized");
    if (resource && payload.resource && resource.href !== payload.resource) {
      throw new InvalidGrantError("resource does not match the original grant");
    }
    // A refresh may narrow scopes, never widen them (RFC 6749 6).
    const granted = scopes?.length ? scopes.filter((s) => payload.scopes.includes(s)) : payload.scopes;
    return this.issue({ ...payload, scopes: granted });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const opened = this.sealer.open<TokenPayload>("access", token);
    if (!opened) throw new InvalidTokenError("invalid or expired access token");
    const payload = opened.payload;
    if (!this.users.allows(payload.email)) throw new InvalidTokenError("this account is no longer authorized");
    // By origin, not by exact URL. Clients differ on whether the resource they ask for is the
    // MCP endpoint, the bare origin or either with a trailing slash, and every one of those
    // names this server; an exact comparison would lock a correct client out over spelling.
    if (payload.resource && new URL(payload.resource).origin !== this.resourceUrl.origin) {
      throw new InvalidTokenError("token was issued for a different resource");
    }
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt: opened.expiresAt,
      resource: payload.resource ? new URL(payload.resource) : undefined,
      extra: { email: payload.email },
    };
  }

  private issue(payload: TokenPayload): OAuthTokens {
    const remaining = payload.grantExpiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) throw new InvalidGrantError("this sign-in has expired; sign in again");
    const accessTtl = Math.min(ACCESS_TOKEN_TTL, remaining);
    return {
      access_token: this.sealer.seal<TokenPayload>("access", payload, accessTtl),
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_token: this.sealer.seal<TokenPayload>("refresh", payload, Math.min(REFRESH_TOKEN_TTL, remaining)),
      scope: payload.scopes.join(" ") || undefined,
    };
  }

  private redeem(code: string): void {
    const now = Date.now();
    for (const [seen, expires] of this.redeemed) if (expires < now) this.redeemed.delete(seen);
    if (this.redeemed.has(code)) throw new InvalidGrantError("authorization code already used");
    this.redeemed.set(code, now + AUTHORIZATION_CODE_TTL * 1000);
  }
}
