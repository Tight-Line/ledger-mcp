import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Sign-in with an external OpenID Connect provider, Google by default. This server never sees
// a password; what it takes from the provider is one fact, a verified email address, and the
// allowlist decides what that address may do.

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface Identity {
  email: string;
  name?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

export class OidcClient {
  private constructor(
    private readonly metadata: DiscoveryDocument,
    private readonly jwks: JWTVerifyGetKey,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  static async discover(options: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<OidcClient> {
    const url = new URL(".well-known/openid-configuration", options.issuer.endsWith("/") ? options.issuer : `${options.issuer}/`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`OIDC discovery failed: ${url} answered ${response.status}`);
    const metadata = (await response.json()) as DiscoveryDocument;
    // The issuer in the document must be the one configured, byte for byte (OIDC Discovery
    // 4.3). Otherwise a discovery document served from one place could name another issuer,
    // and tokens from that other issuer would verify.
    if (metadata.issuer !== options.issuer) {
      throw new Error(`OIDC issuer mismatch: configured ${options.issuer}, discovery says ${metadata.issuer}`);
    }
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (!metadata[key]) throw new Error(`OIDC discovery document has no ${key}`);
    }
    return new OidcClient(
      metadata,
      createRemoteJWKSet(new URL(metadata.jwks_uri)),
      options.clientId,
      options.clientSecret,
      options.redirectUri,
    );
  }

  authorizationUrl(params: { state: string; nonce: string; codeChallenge: string; loginHint?: string }): string {
    const url = new URL(this.metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Always offer the account chooser. Someone signed in to a personal Google account would
    // otherwise be signed in as that account silently and refused, with no obvious way to
    // pick the work one.
    url.searchParams.set("prompt", "select_account");
    if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
    return url.href;
  }

  async exchange(code: string, codeVerifier: string, expectedNonce: string): Promise<Identity> {
    const response = await fetch(this.metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code_verifier: codeVerifier,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!response.ok || !body.id_token) {
      throw new Error(`OIDC token exchange failed: ${response.status} ${body.error ?? ""}`.trim());
    }

    // Verified against the provider's published keys even though it arrived over TLS straight
    // from the token endpoint, which OIDC Core 3.1.3.7 would accept on its own. The signature
    // check costs one cached key fetch and removes the need to argue about it.
    const { payload } = await jwtVerify(body.id_token, this.jwks, {
      issuer: this.metadata.issuer,
      audience: this.clientId,
    });
    if (payload.nonce !== expectedNonce) throw new Error("OIDC nonce mismatch");

    // An unverified address is a claim, not an identity. Google sets this true for every
    // Workspace account and for consumer accounts whose address has been confirmed; anything
    // else is refused here rather than trusted by the allowlist.
    if (payload.email_verified !== true || typeof payload.email !== "string") {
      throw new Error("the identity provider did not return a verified email address");
    }
    return {
      email: payload.email.toLowerCase(),
      name: typeof payload.name === "string" ? payload.name : undefined,
    };
  }
}
