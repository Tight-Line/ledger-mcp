// Which redirect URIs an MCP client may register.
//
// WITHOUT THIS, DYNAMIC REGISTRATION IS A PHISHING KIT. Registration is open by design (that is
// how Claude connects without anyone pre-provisioning it), so a stranger can register a client
// whose redirect_uri is their own server, send an allowed person an /authorize link, and receive
// that person's authorization code when they sign in. Exact redirect matching does not help: the
// attacker's URI is the registered one. Restricting what may be registered closes it, and the
// consent page closes what remains.
//
// Each entry is an exact URL, or `loopback`, which allows http on 127.0.0.1, [::1] or localhost
// on any port and path (RFC 8252 7.3: native clients such as Claude Code listen on a random
// port). A code sent to loopback reaches only a program on the user's own machine.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export class RedirectPolicy {
  private readonly exact = new Set<string>();
  private readonly loopback: boolean;

  constructor(entries: string[]) {
    let loopback = false;
    for (const entry of entries) {
      if (entry === "loopback") {
        loopback = true;
        continue;
      }
      const url = new URL(entry);
      if (url.protocol !== "https:" || url.hash) throw new Error(`client redirect must be https with no fragment: ${entry}`);
      this.exact.add(url.href);
    }
    this.loopback = loopback;
  }

  allows(uri: string): boolean {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    if (url.hash) return false;
    if (this.loopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password) {
      return true;
    }
    return this.exact.has(url.href);
  }
}
