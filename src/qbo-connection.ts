import fs from "node:fs";
import path from "node:path";
import OAuthClient from "intuit-oauth";
import type { Config } from "./config.js";
import type { Upstream } from "./upstream.js";

// The link between this deployment and ONE QuickBooks Online company. Every allowed user's
// tools act on that company, so connecting it is an admin act, done in a browser at
// /qbo/connect over Intuit's OAuth -- which is the step Intuit requires a public HTTPS
// redirect for, and the reason this server has to be on the internet at all.
//
// THE TOKEN STORE IS UPSTREAM'S FILE. Upstream reads QUICKBOOKS_REFRESH_TOKEN and
// QUICKBOOKS_REALM_ID from QUICKBOOKS_TOKEN_STORE_PATH and writes the rotated refresh token
// back to it, roughly daily. This module writes the same file in the same format on connect,
// and deletes it on disconnect; upstream owns it the rest of the time. Beside it,
// connection.json records who connected which company and when, which upstream knows nothing
// about.

interface ConnectionRecord {
  realmId: string;
  connectedBy: string;
  connectedAt: string;
  environment: string;
}

export interface ConnectionStatus {
  connected: boolean;
  realmId?: string;
  connectedBy?: string;
  connectedAt?: string;
  environment: string;
}

export class QboConnection {
  private readonly recordPath: string;

  constructor(
    private readonly config: Config,
    private readonly upstream: Upstream,
  ) {
    this.recordPath = path.join(path.dirname(config.qbo.tokenStorePath), "connection.json");
  }

  private oauthClient(): OAuthClient {
    return new OAuthClient({
      clientId: this.config.qbo.clientId,
      clientSecret: this.config.qbo.clientSecret,
      environment: this.config.qbo.environment,
      redirectUri: this.config.qbo.redirectUri,
    });
  }

  isConnected(): boolean {
    const { refreshToken, realmId } = this.upstream.credentials();
    return Boolean(refreshToken && realmId);
  }

  status(): ConnectionStatus {
    const { realmId } = this.upstream.credentials();
    let record: Partial<ConnectionRecord> = {};
    try {
      record = JSON.parse(fs.readFileSync(this.recordPath, "utf8"));
    } catch {
      /* no record: connected before this file existed, or never */
    }
    return {
      connected: this.isConnected(),
      realmId,
      connectedBy: record.realmId === realmId ? record.connectedBy : undefined,
      connectedAt: record.realmId === realmId ? record.connectedAt : undefined,
      environment: this.config.qbo.environment,
    };
  }

  authorizationUrl(state: string): string {
    return this.oauthClient().authorizeUri({ scope: [OAuthClient.scopes.Accounting as string], state });
  }

  // `callbackUrl` is the path and query Intuit redirected to. intuit-oauth parses the code
  // and realmId out of it itself.
  async complete(callbackUrl: string, connectedBy: string): Promise<ConnectionStatus> {
    const response = await this.oauthClient().createToken(callbackUrl);
    const token = response.token as { refresh_token?: string; realmId?: string };
    if (!token.refresh_token || !token.realmId) {
      throw new Error("Intuit returned no refresh token or realm ID");
    }
    // intuit-oauth takes realmId from the callback's QUERY STRING, not from Intuit's token
    // response, and both values are about to become lines in a dotenv file that upstream loads
    // with override: true. A newline in either would add arbitrary settings to this server's
    // environment at the next start. Realm IDs are decimal; refresh tokens are URL-safe text.
    if (!/^\d{1,32}$/.test(token.realmId) || !/^[A-Za-z0-9._~-]{16,4096}$/.test(token.refresh_token)) {
      throw new Error("Intuit returned a realm ID or refresh token in an unexpected format");
    }
    this.writeTokenStore(token.refresh_token, token.realmId);
    this.writeRecord({
      realmId: token.realmId,
      connectedBy,
      connectedAt: new Date().toISOString(),
      environment: this.config.qbo.environment,
    });
    this.upstream.setCredentials({ refreshToken: token.refresh_token, realmId: token.realmId });
    return this.status();
  }

  // Revoke at Intuit, then forget locally. The local half happens even if Intuit's half
  // fails, because the person asking for a disconnect wants this server to stop acting on the
  // company, and that is the half this server controls.
  async disconnect(): Promise<{ revoked: boolean }> {
    const { refreshToken } = this.upstream.credentials();
    let revoked = false;
    if (refreshToken) {
      try {
        await this.oauthClient().revoke({ refresh_token: refreshToken });
        revoked = true;
      } catch (error) {
        console.error(JSON.stringify({ event: "qbo_revoke_failed", error: String(error) }));
      }
    }
    for (const file of [this.config.qbo.tokenStorePath, this.recordPath]) {
      fs.rmSync(file, { force: true });
    }
    this.upstream.setCredentials(null);
    return { revoked };
  }

  private writeTokenStore(refreshToken: string, realmId: string): void {
    // Upstream's format: dotenv lines. Written atomically, and 0600, as upstream writes it.
    this.atomicWrite(
      this.config.qbo.tokenStorePath,
      `QUICKBOOKS_REFRESH_TOKEN=${refreshToken}\nQUICKBOOKS_REALM_ID=${realmId}\n`,
    );
  }

  private writeRecord(record: ConnectionRecord): void {
    this.atomicWrite(this.recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private atomicWrite(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
