// An allowlist of email addresses. Each entry is either an exact address or `*@domain`,
// which matches every address at exactly that domain and not its subdomains.
//
// Anything else is rejected when the list is built, not ignored when it is consulted. An
// entry that can never match, such as `*.example.com` or a bare `*`, would otherwise read as
// a grant while granting nothing, or be one character away from granting everyone.

const ADDRESS = /^[^\s@*]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN_WILDCARD = /^\*@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export class EmailAllowlist {
  private readonly exact = new Set<string>();
  private readonly domains = new Set<string>();

  constructor(entries: string[], options: { allowWildcards?: boolean } = {}) {
    const allowWildcards = options.allowWildcards ?? true;
    for (const raw of entries) {
      const entry = raw.trim().toLowerCase();
      if (DOMAIN_WILDCARD.test(entry)) {
        if (!allowWildcards) throw new Error(`wildcards are not allowed here: ${raw}`);
        this.domains.add(entry.slice(2));
      } else if (ADDRESS.test(entry)) {
        this.exact.add(entry);
      } else {
        throw new Error(`not an email address or *@domain: ${raw}`);
      }
    }
  }

  get size(): number {
    return this.exact.size + this.domains.size;
  }

  allows(email: string | undefined | null): boolean {
    if (!email) return false;
    const normalized = email.trim().toLowerCase();
    if (!ADDRESS.test(normalized)) return false;
    if (this.exact.has(normalized)) return true;
    return this.domains.has(normalized.slice(normalized.lastIndexOf("@") + 1));
  }

  describe(): string[] {
    return [...this.exact, ...[...this.domains].map((d) => `*@${d}`)];
  }
}
