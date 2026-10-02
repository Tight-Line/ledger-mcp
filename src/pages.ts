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

// Who made the software, as distinct from who operates this deployment (config.site.operator).
// Fixed, like any "made by" mark, and the same on every deployment.
const MAKER_URL = "https://www.tightlinesoftware.com";
const SOURCE_URL = "https://github.com/Tight-Line/ledger-mcp";
// Tight Line's wordmark, inline so the Content-Security-Policy need not allow any image source.
const WORDMARK = `<svg class="wordmark" role="img" aria-label="Tight Line" viewBox="0 0 152 26" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M32.2552 11.361L24.811 1.51718C23.7853 0.16115 21.8055 0.160833 20.7797 1.51687L19.9085 2.66883L26.4816 11.361C27.2101 12.3238 27.2098 13.6783 26.4816 14.6408L19.9078 23.331L20.7788 24.4827C21.8043 25.8387 23.7841 25.839 24.8098 24.483L32.2549 14.6408C32.983 13.6783 32.9834 12.3238 32.2552 11.361Z" fill="#0275D3"/> <path d="M5.54609 14.6395L12.9902 24.483C14.016 25.839 15.9958 25.839 17.0215 24.483L24.4666 14.6411C25.1947 13.6783 25.1947 12.3238 24.4666 11.361L17.0224 1.51718C15.997 0.16115 14.0172 0.160833 12.9915 1.51687L5.5464 11.3594C4.81792 12.3222 4.81792 13.6767 5.54609 14.6395Z" fill="#0275D3"/> <path d="M51.7469 8.87368H46.8554V19.8666H43.8271V8.87368H38.9353V6.17591H51.7469V8.87368Z" fill="#0275D3"/> <path d="M56.154 6.17556H53.1257V19.8662H56.154V6.17556Z" fill="#0275D3"/> <path d="M71.0428 18.4771C69.6064 19.5643 67.7817 20.1078 65.5105 20.1078C60.6578 20.1078 57.7847 17.4504 57.7847 13.081C57.7847 8.65178 60.7354 5.93367 65.3554 5.93367C67.238 5.93367 68.8494 6.37678 70.2859 7.32308L69.3928 9.86C68.0728 9.05452 66.8886 8.71217 65.5883 8.71217C62.6765 8.71217 60.8714 10.3832 60.8714 13.0409C60.8714 15.7187 62.6958 17.3296 65.7048 17.3296C66.5393 17.3296 67.3159 17.2088 68.0728 16.9469V14.5712H64.6759V11.8734H71.0428V18.4771Z" fill="#0275D3"/> <path d="M85.6795 6.17556V19.8662H82.6513V14.3296H75.8961V19.8662H72.8679V6.17556H75.8961V11.6318H82.6513V6.17556H85.6795Z" fill="#0275D3"/> <path d="M99.8699 8.87368H94.9784V19.8666H91.9502V8.87368H87.0583V6.17591H99.8699V8.87368Z" fill="#0275D3"/> <path d="M117.652 17.1685V19.8662H108.553C107.199 19.8662 106.102 18.7279 106.102 17.3233V6.17556H109.13V17.1685H117.652Z" fill="#0275D3"/> <path d="M122.365 6.17556H119.337V19.8662H122.365V6.17556Z" fill="#0275D3"/> <path d="M137.506 6.17556V19.8662H134.711L127.587 9.96044V19.8662H124.695V6.17556H128.286L134.614 14.9739V6.17556H137.506Z" fill="#0275D3"/> <path d="M142.864 8.87368V11.6322H150.512V14.3299H142.864V17.1688H151.774V19.8666H139.836V6.17591H151.774V8.87368H142.864Z" fill="#0275D3"/> </svg>`;

const STYLE = `
:root { --bg:#fbfaf7; --fg:#1d2327; --muted:#5c6770; --rule:#dcd8cf; --accent:#1f5f8b; --ok:#2e7d4f; --bad:#a23b2a; }
@media (prefers-color-scheme: dark) { :root { --bg:#14181b; --fg:#e6e3dc; --muted:#9aa4ab; --rule:#2c3338; --accent:#7fb8de; --ok:#7cc59a; --bad:#e38b7a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
header { border-bottom:1px solid var(--rule); margin-bottom:1.5rem; padding-bottom:1rem; }
header { display:flex; flex-wrap:wrap; align-items:baseline; gap:.25rem .6rem; }
header a.home { color:inherit; text-decoration:none; font-weight:600; font-size:1.1rem; }
header a.maker { display:inline-flex; align-items:center; gap:.35rem; color:var(--muted); text-decoration:none; font-size:.85rem; }
header .wordmark { height:14px; width:auto; }
h1 { font-size:1.6rem; line-height:1.25; margin:0 0 .5rem; }
h2 { font-size:1.15rem; margin:2rem 0 .5rem; }
p, li { color:var(--fg); }
.muted { color:var(--muted); }
a { color:var(--accent); }
footer { border-top:1px solid var(--rule); margin-top:3rem; padding-top:1rem; font-size:.9rem; color:var(--muted); }
footer nav { display:flex; flex-wrap:wrap; gap:.25rem 1rem; }
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
<header><a class="home" href="/">${escapeHtml(appName)}</a><a class="maker" href="${MAKER_URL}">by ${WORDMARK}</a></header>
${body}
<footer>
<nav><a href="/eula">End-User License Agreement</a><a href="/privacy">Privacy Policy</a><a href="${SOURCE_URL}">Source code</a></nav>
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
<p>${escapeHtml(appName)} connects AI assistants that support the Model Context Protocol, such as
Claude, to a QuickBooks Online company operated by ${escapeHtml(operator)}. It is used by the people
${escapeHtml(operator)} has authorized, from wherever they work.</p>
<p class="muted">There is nothing to sign up for. Only accounts ${escapeHtml(operator)} has approved
can sign in, and each person approves every assistant they connect.</p>
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
<p>The Service connects an AI assistant of your choosing, through the Model Context Protocol, to a
QuickBooks Online company that ${o} has connected to it, so that you can read and, where enabled,
create or change accounting records in that company. It is available only to people ${o} has
authorized; there is no public sign-up.</p>

<h2>2. Who may use it</h2>
<p>Only people whose accounts ${o} has authorized may use the Service, and only for the purposes
${o} authorized them for. Authorization is personal: you may not share your access, sign in on another
person's behalf, or let anyone else use a session or token issued to you. ${o} may grant, change or
withdraw authorization at any time, for any reason, with immediate effect.</p>

<h2>3. License</h2>
<p>Subject to this Agreement, ${o} grants you a limited, revocable, non-exclusive, non-transferable
license to use the Service for the purposes ${o} has authorized while you remain authorized. All
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
to it. The Service is used only by people ${o} has authorized, to work with a QuickBooks Online
company ${o} has connected to it.</p>

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
<p>The Service runs on infrastructure operated by ${o} in ${escapeHtml(config.site.hostingLocation)}. Traffic to and from it is
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
