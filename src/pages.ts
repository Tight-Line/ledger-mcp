import type { Config } from "./config.js";
import type { ConnectionStatus } from "./qbo-connection.js";

// Every page this server renders. Plain server-side HTML with no scripts, so there is nothing
// to load from anywhere else and the Content-Security-Policy can forbid everything but inline
// style.

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root { --bg:#fbfaf7; --fg:#1d2327; --muted:#5c6770; --rule:#dcd8cf; --accent:#1f5f8b; --ok:#2e7d4f; --bad:#a23b2a; }
@media (prefers-color-scheme: dark) { :root { --bg:#14181b; --fg:#e6e3dc; --muted:#9aa4ab; --rule:#2c3338; --accent:#7fb8de; --ok:#7cc59a; --bad:#e38b7a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
header { border-bottom:1px solid var(--rule); margin-bottom:1.5rem; padding-bottom:1rem; }
header a.home { color:inherit; text-decoration:none; font-weight:600; font-size:1.1rem; }
h1 { font-size:1.6rem; line-height:1.25; margin:0 0 .5rem; }
h2 { font-size:1.15rem; margin:2rem 0 .5rem; }
p, li { color:var(--fg); }
.muted { color:var(--muted); }
a { color:var(--accent); }
footer { border-top:1px solid var(--rule); margin-top:3rem; padding-top:1rem; font-size:.9rem; color:var(--muted); }
footer a { margin-right:1rem; }
.status { border:1px solid var(--rule); border-radius:6px; padding:1rem 1.25rem; margin:1.5rem 0; }
.ok { color:var(--ok); font-weight:600; } .bad { color:var(--bad); font-weight:600; }
button, .button { display:inline-block; font:inherit; padding:.45rem 1rem; border-radius:5px; border:1px solid var(--accent); background:var(--accent); color:var(--bg); text-decoration:none; cursor:pointer; }
button.secondary { background:transparent; color:var(--accent); }
form { display:inline; }
code { font-size:.92em; background:color-mix(in srgb, var(--rule) 45%, transparent); padding:.1em .3em; border-radius:3px; overflow-wrap:anywhere; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:.25rem 1rem; margin:.5rem 0 0; }
dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
`;

function layout(config: Config, title: string, body: string): string {
  const { appName, operator } = config.site;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title === appName ? appName : `${title} · ${appName}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><a class="home" href="/">${escapeHtml(appName)}</a></header>
${body}
<footer>
<a href="/eula">End-User License Agreement</a><a href="/privacy">Privacy Policy</a>
<div>Operated by ${escapeHtml(operator)}. Contact <a href="mailto:${escapeHtml(config.site.contactEmail)}">${escapeHtml(config.site.contactEmail)}</a>.</div>
</footer>
</main>
</body>
</html>`;
}

export interface Viewer {
  email: string;
  isAdmin: boolean;
}

export function homePage(config: Config, viewer: Viewer | null, status: ConnectionStatus): string {
  const { appName, operator } = config.site;
  const mcpUrl = new URL("/mcp", config.publicUrl).href;

  let account: string;
  if (!viewer) {
    account = `<p><a class="button" href="/login">Sign in</a></p>`;
  } else {
    const connection = status.connected
      ? `<p><span class="ok">Connected</span> to a QuickBooks Online ${escapeHtml(status.environment)} company.</p>
<dl><dt>Realm ID</dt><dd><code>${escapeHtml(status.realmId)}</code></dd>
${status.connectedBy ? `<dt>Connected by</dt><dd>${escapeHtml(status.connectedBy)}</dd>` : ""}
${status.connectedAt ? `<dt>Connected at</dt><dd>${escapeHtml(status.connectedAt)}</dd>` : ""}</dl>`
      : `<p><span class="bad">Not connected</span> to QuickBooks Online. Tools will report this until an administrator connects a company.</p>`;
    const actions = viewer.isAdmin
      ? `<p>${status.connected ? `<a class="button" href="/qbo/connect">Reconnect</a>
<form method="post" action="/qbo/disconnect"><button class="secondary" type="submit">Disconnect</button></form>`
          : `<a class="button" href="/qbo/connect">Connect to QuickBooks</a>`}</p>`
      : "";
    account = `<div class="status">
<p>Signed in as <strong>${escapeHtml(viewer.email)}</strong>${viewer.isAdmin ? " (administrator)" : ""}.</p>
${connection}
${actions}
<form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
</div>`;
  }

  return layout(
    config,
    appName,
    `<h1>${escapeHtml(appName)}</h1>
<p>${escapeHtml(appName)} is a private tool operated by ${escapeHtml(operator)} for its own bookkeeping. It
lets a small number of named people at ${escapeHtml(operator)} reach the company's QuickBooks Online
records from an AI assistant that supports the Model Context Protocol, such as Claude.</p>
<p class="muted">It is not offered to the public, there is nothing to sign up for, and only
pre-authorized accounts can sign in.</p>
${account}
<h2>Using it</h2>
<p>Add this MCP server to your assistant:</p>
<p><code>${escapeHtml(mcpUrl)}</code></p>
<p class="muted">In Claude, add it as a custom connector. In Claude Code, run
<code>claude mcp add --transport http ledger ${escapeHtml(mcpUrl)}</code>. Either will send you here to sign in
the first time.</p>`,
  );
}

export function consentPage(
  config: Config,
  consent: { email: string; clientName?: string; pending: { redirectUri: string } },
  token: string,
): string {
  const redirect = new URL(consent.pending.redirectUri);
  const where = redirect.protocol === "http:" ? `a program on this computer (${redirect.host})` : redirect.host;
  return layout(
    config,
    "Allow access?",
    `<h1>Allow access to QuickBooks?</h1>
<p>An application that calls itself <strong>${escapeHtml(consent.clientName || "an unnamed client")}</strong> is asking to use
${escapeHtml(config.site.appName)} as <strong>${escapeHtml(consent.email)}</strong>.</p>
<div class="status">
<p>If you allow it, it will be able to read and, where enabled, change records in the connected QuickBooks
Online company, until you remove it or your access is withdrawn.</p>
<p>Access will be sent to: <strong>${escapeHtml(where)}</strong></p>
</div>
<p>Only continue if you started this from your own assistant just now. If you followed a link someone sent
you, choose <strong>Deny</strong>.</p>
<form method="post" action="/authorize/consent">
<input type="hidden" name="consent" value="${escapeHtml(token)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button class="secondary" type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}

export function messagePage(config: Config, title: string, message: string, status?: number): string {
  return layout(
    config,
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${status ? `<p class="muted">HTTP ${status}</p>` : ""}
<p><a href="/">Return to the start page</a></p>`,
  );
}

export function forbiddenPage(config: Config, email: string, what: string): string {
  return layout(
    config,
    "Not authorized",
    `<h1>Not authorized</h1>
<p>You signed in as <strong>${escapeHtml(email)}</strong>, which is not authorized to ${escapeHtml(what)}.</p>
<p>If you expected access, ask ${escapeHtml(config.site.operator)} at
<a href="mailto:${escapeHtml(config.site.contactEmail)}">${escapeHtml(config.site.contactEmail)}</a>,
or <a href="/login">sign in with a different account</a>.</p>`,
  );
}

export function disconnectedPage(config: Config): string {
  return layout(
    config,
    "Disconnected",
    `<h1>Disconnected from QuickBooks</h1>
<p>${escapeHtml(config.site.appName)} no longer has access to your QuickBooks Online company. Intuit
has revoked the authorization, and requests made through this server will fail until the company is
connected again.</p>
<p>To reconnect, an administrator can sign in at the <a href="/">start page</a> and choose
<strong>Connect to QuickBooks</strong>.</p>`,
  );
}

export function eulaPage(config: Config): string {
  const { appName, operator, contactEmail, legalEffectiveDate, governingLaw, venue } = config.site;
  const a = escapeHtml(appName);
  const o = escapeHtml(operator);
  return layout(
    config,
    "End-User License Agreement",
    `<h1>End-User License Agreement</h1>
<p class="muted">Effective ${escapeHtml(legalEffectiveDate)}</p>

<p>This End-User License Agreement ("Agreement") is between ${o} ("${o}", "we", "us") and you, an
individual whom ${o} has authorized to use ${a} (the "Service"). By signing in to or using the Service
you agree to this Agreement. If you do not agree, do not use the Service.</p>

<h2>1. What the Service is</h2>
<p>The Service is a private, internally operated tool. It connects an AI assistant of your choosing,
through the Model Context Protocol, to a QuickBooks Online company that belongs to ${o}, so that you
can read and, where enabled, create or change accounting records in that company. The Service is
not offered to the public and is not sold, licensed or distributed to anyone outside ${o}.</p>

<h2>2. Who may use it</h2>
<p>Only people whose accounts ${o} has individually authorized may use the Service, and only for
${o}'s business. Authorization is personal: you may not share your access, sign in on another
person's behalf, or let anyone else use a session or token issued to you. ${o} may grant, change or
withdraw authorization at any time, for any reason, with immediate effect.</p>

<h2>3. License</h2>
<p>Subject to this Agreement, ${o} grants you a limited, revocable, non-exclusive, non-transferable
license to use the Service for ${o}'s internal business purposes while you remain authorized. All
rights not expressly granted are reserved.</p>

<h2>4. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
<li>attempt to access any QuickBooks Online company, account or data you are not authorized to access;</li>
<li>probe, scan or test the Service's security, or circumvent its authentication or access controls;</li>
<li>use the Service to violate any law, or Intuit's terms for QuickBooks Online and its developer platform;</li>
<li>use the Service to make changes to accounting records you are not responsible for making.</li>
</ul>

<h2>5. Your responsibility for changes</h2>
<p>An AI assistant acting through the Service may create, change or delete records in QuickBooks
Online when you ask it to. You are responsible for reviewing what your assistant proposes and for
the changes made at your request. QuickBooks Online remains the system of record; check important
results there.</p>

<h2>6. Third-party services</h2>
<p>The Service relies on services ${o} does not control, including QuickBooks Online (provided by
Intuit Inc.), the identity provider you sign in with, and the AI assistant you connect. Your use of
those services is governed by their own terms. Intuit is not a party to this Agreement and is not
responsible for the Service.</p>

<h2>7. Open-source components</h2>
<p>The Service is built on open-source software, including Intuit's QuickBooks Online MCP server,
which is used under its own license. Nothing in this Agreement limits your rights under those
licenses with respect to those components.</p>

<h2>8. No warranty</h2>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS,
IMPLIED OR STATUTORY, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
ACCURACY AND NON-INFRINGEMENT. ${o} does not warrant that the Service will be uninterrupted or error
free, or that information obtained through it, or produced by an AI assistant using it, is accurate.</p>

<h2>9. Limitation of liability</h2>
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, ${o} WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, PROFITS OR REVENUE, ARISING OUT OF OR
RELATING TO THE SERVICE, AND ITS TOTAL LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE WILL NOT
EXCEED ONE HUNDRED U.S. DOLLARS (US$100).</p>

<h2>10. Termination</h2>
<p>This Agreement continues while you are authorized to use the Service and ends automatically when
that authorization is withdrawn. ${o} may suspend or discontinue the Service at any time. Sections 5
through 9, 11 and 12 survive termination.</p>

<h2>11. Governing law</h2>
<p>This Agreement is governed by the laws of ${escapeHtml(governingLaw)}, without regard to its conflict
of laws rules. Any dispute arising out of or relating to it will be brought exclusively in the state
or federal courts located in ${escapeHtml(venue)}, and each party consents to their jurisdiction.</p>

<h2>12. Changes and contact</h2>
<p>${o} may update this Agreement by publishing a new version at this address with a new effective
date; continued use after that date is acceptance. Where you have a separate written agreement with
${o}, that agreement controls if it conflicts with this one. Questions:
<a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a>.</p>`,
  );
}

export function privacyPage(config: Config): string {
  const { appName, operator, contactEmail, legalEffectiveDate } = config.site;
  const a = escapeHtml(appName);
  const o = escapeHtml(operator);
  return layout(
    config,
    "Privacy Policy",
    `<h1>Privacy Policy</h1>
<p class="muted">Effective ${escapeHtml(legalEffectiveDate)}</p>

<p>This policy describes what ${a} (the "Service"), operated by ${o}, collects, why, and what happens
to it. The Service is a private tool used only by people ${o} has authorized, to work with ${o}'s own
QuickBooks Online company.</p>

<h2>What the Service collects</h2>
<ul>
<li><strong>Your sign-in identity.</strong> When you sign in, your identity provider (for example
Google) tells the Service your email address, whether it is verified, and your name. The Service uses
the email address to decide whether you are authorized. It does not receive or store your password.</li>
<li><strong>QuickBooks Online authorization.</strong> When an administrator connects the company, Intuit
issues OAuth tokens and a company identifier (realm ID). The Service stores these so it can act on the
company, along with the administrator's email address and the time of connection.</li>
<li><strong>QuickBooks Online data, in transit.</strong> When your AI assistant calls a tool, the Service
requests the relevant records from QuickBooks Online and returns them to your assistant. It does not keep
a copy of that data after the response is sent.</li>
<li><strong>Operational logs.</strong> For each tool call the Service logs your email address, the tool
name, whether it succeeded, and how long it took, together with ordinary web server logs (time, request
path, and network address). Logs do not contain the QuickBooks records themselves.</li>
</ul>

<h2>How it is used</h2>
<p>Only to operate the Service: to authenticate you, enforce who may use it, perform the actions you
request in QuickBooks Online, keep the connection to QuickBooks Online working, and investigate faults
or misuse. The Service does not sell or rent information, does not use it for advertising, and does not
use QuickBooks Online data for any purpose other than answering the request that fetched it.</p>

<h2>Who it is shared with</h2>
<ul>
<li><strong>Intuit</strong>, which provides QuickBooks Online and receives the requests the Service makes on
your behalf.</li>
<li><strong>Your identity provider</strong>, which you sign in with.</li>
<li><strong>The AI assistant you connect.</strong> Data returned by a tool goes to the assistant you chose,
and is handled under that assistant's own terms and privacy policy.</li>
</ul>
<p>${o} may also disclose information where required by law.</p>

<h2>Storage and security</h2>
<p>The Service runs on infrastructure operated by ${o} in the United States. Traffic to and from it is
encrypted with TLS. Stored OAuth tokens are kept on encrypted storage, accessible only to the Service and to the
${o} administrators who operate it.
Tokens the Service issues to your assistant are encrypted and expire: access tokens after one hour,
refresh tokens after thirty days. Access is checked against the list of authorized people on every
request, so removing someone takes effect at their next request.</p>

<h2>Retention</h2>
<p>QuickBooks Online authorization is kept until the company is disconnected, at which point the Service
revokes it with Intuit and deletes it. Operational logs are kept for no more than ninety days.</p>

<h2>Your choices</h2>
<p>You can stop using the Service at any time, and revoke your assistant's access by removing the
connector. The company's owner can disconnect the Service from QuickBooks Online, either here or from
the QuickBooks Online settings for connected apps. To ask what the Service holds about you, or to ask for
it to be deleted, write to <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a>.</p>

<h2>Changes</h2>
<p>${o} may update this policy by publishing a new version at this address with a new effective date.</p>`,
  );
}
