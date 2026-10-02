import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// Authenticated, encrypted, self-describing tokens. Everything this server hands out --
// OAuth client IDs, authorization codes, access and refresh tokens, login state, the browser
// session -- is a sealed blob rather than a key into a database, so the server keeps no state
// between requests and a pod restart signs nobody out.
//
// The KIND is bound in as additional authenticated data, so a token minted as one kind cannot
// be presented as another: a refresh token is not an access token, and a client ID (which is
// public) is not a session.
//
// The cost of statelessness is revocation. An individual token cannot be revoked before it
// expires; what CAN be done is removing the person from the allowlist, which every token
// check consults on every use, or rotating SEAL_KEY, which invalidates everything at once.

export type SealKind = "client" | "login" | "consent" | "code" | "access" | "refresh" | "session" | "qbo-state";

interface Envelope<T> {
  e: number; // expiry, seconds since epoch; 0 never expires
  p: T;
}

export class Sealer {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("seal key must be 32 bytes");
    // Separate keys for separate jobs, derived rather than configured, so one secret is all
    // there is to generate, store and rotate.
    this.encKey = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "ledger-mcp seal v1", 32));
    this.macKey = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "ledger-mcp mac v1", 32));
  }

  seal<T>(kind: SealKind, payload: T, ttlSeconds?: number): string {
    const envelope: Envelope<T> = {
      e: ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : 0,
      p: payload,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encKey, iv);
    cipher.setAAD(Buffer.from(kind));
    const body = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  // Returns null for anything that is not a live token of this kind: tampered, truncated,
  // expired, the wrong kind, or sealed under a different key. Callers do not need to know
  // which, and should not tell the client.
  open<T>(kind: SealKind, token: string | undefined | null): { payload: T; expiresAt: number } | null {
    if (!token) return null;
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length < 12 + 16 + 1) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.encKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(kind));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      const envelope = JSON.parse(json) as Envelope<T>;
      if (envelope.e !== 0 && envelope.e <= Math.floor(Date.now() / 1000)) return null;
      return { payload: envelope.p, expiresAt: envelope.e };
    } catch {
      return null;
    }
  }

  // A deterministic secret bound to a public value, for OAuth client secrets: the client ID
  // is sealed and public, and its secret is derived from it, so neither needs storing.
  derive(purpose: string, value: string): string {
    return createHmac("sha256", this.macKey).update(purpose).update("\0").update(value).digest("base64url");
  }

  static equal(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
