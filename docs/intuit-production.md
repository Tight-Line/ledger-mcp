# Intuit production checklist

What the Intuit Developer Portal asks before it issues production keys, and what this deployment
answers. Checked against Intuit's documentation and support answers on 2026-10-01. A private app,
used only for the owner's own company, gets no exemption from any of it.

`HOST` below is your deployment's hostname.

## Keys & credentials → Production → App details

| Field | Value |
|---|---|
| App name | Yours; it need not match `APP_NAME`. No "QuickBooks", "QB", "QBO", "Intuit", "quick" or sound-alikes. |
| Host domain | `HOST` (no scheme) |
| Launch URL | `https://HOST/` |
| Disconnect URL | `https://HOST/qbo/disconnected` |
| Connect/Reconnect URL | `https://HOST/qbo/connect` |
| EULA URL | `https://HOST/eula` |
| Privacy policy URL | `https://HOST/privacy` |
| Categories | Accounting (plus anything else that genuinely applies, up to four) |
| Regulated industries | None. Ticking Lending adds a whole lending section to the questionnaire. |
| Where hosted | Wherever it runs; match `HOSTING_LOCATION`. |
| Redirect URIs (Production) | `https://HOST/qbo/callback` |

All of these share the host domain. Intuit does not document whether that is required, and its own
examples always do it, so this deployment does too.

What each URL does, since reviewers may open them:

- **Launch** is the start page: what the app is, sign-in, connection status, and the connect and
  disconnect controls for administrators.
- **Disconnect** is a static page shown after someone disconnects the app from inside QuickBooks.
  It changes nothing, because anyone can load it; Intuit has already revoked the grant.
- **Connect/Reconnect** sends a signed-in administrator through Intuit's OAuth flow. Intuit shows
  it to the company when a connection is close to expiring.

## Production → Compliance → App Assessment Questionnaire

Answer truthfully; these notes say what is true of this deployment, so you do not have to work it
out under the form's time pressure.

**App information.** Built on an open-source server (this one), deployed and operated by you.
Private: used only by the people on your allowlist, for the company you connect. Users are named
individually, or by your own email domain.

**Authorization and authentication.**

- Tested connect, disconnect and reconnect on a sandbox company: yes, if you did part 2 of the
  [quickstart](quickstart.md). Do it before starting the questionnaire.
- Refresh: on demand, five minutes before the one-hour access token expires. Concurrent callers
  share one in-flight refresh, so the token is never refreshed twice at once. The newest refresh
  token is always persisted, since Intuit invalidates the previous one on rotation.
- `invalid_grant` is handled as "the grant is gone": tools report that the company must be
  reconnected, and an administrator reconnects from the start page. Transient errors (5xx, 429,
  network) are retried on the next call and do not discard the token.
- CSRF: the OAuth `state` is sealed, expires in ten minutes, and is bound to the signed-in
  administrator; a callback without a matching state is refused.
- The OAuth Playground is not used.
- Discovery document: the `intuit-oauth` library's endpoints are used, not the discovery document.

**API usage.** QuickBooks Online Accounting API. No webhooks, no change data capture polling.
Calls are made only when a user asks their assistant for something.

**Error handling and logging.** Every tool call is logged with the user, the tool, success or
failure and duration, and Intuit's fault messages are returned to the caller in the tool result.
`intuit_tid` is NOT captured: it arrives as a response header, and upstream's client does not keep
it. If the questionnaire insists, answer no; it is an upstream change, not a setting here.

**Security.**

- No breaches.
- The client secret is a Kubernetes Secret, injected as an environment variable, never in source
  control or images.
- MFA: sign-in is through Google Workspace, so it is whatever 2-Step Verification policy the
  Workspace enforces (check **Admin console → Security → 2-Step Verification** before answering).
  This server never handles passwords.
- Captcha: not applicable; there is no public sign-up and no form a stranger can submit.
- WebSockets: none.
- Customer data shown to third parties: QuickBooks data goes only to the AI assistant the
  authorized user chose to connect, at that user's request. It is not stored by this server.

## After approval

Copy the production Client ID and Secret and follow part 3 of the [quickstart](quickstart.md).
