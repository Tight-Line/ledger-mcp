# Quickstart

From nothing to an AI assistant reading your QuickBooks Online books through a server you run,
in three parts:

1. [Install](#1-install): Helm on Kubernetes, or `docker compose up` on one host
2. [Register and validate against a sandbox company](#2-register-and-validate-against-a-sandbox-company)
3. [Switch to production](#3-switch-to-production)

Intuit will not issue production keys until you have tested connecting, disconnecting and
reconnecting against a sandbox company, so part 2 is not optional.

## Before you start

**A hostname.** One public name that will reach this server over HTTPS, such as
`ledger.example.com`. Intuit's trademark rules forbid its marks in domain names, so leave
"qbo", "quickbooks" and "intuit" out of it. Everything below calls it `HOST`.

**A Google OAuth client** (or any OpenID Connect provider). This is how people sign in; the server
never sees a password. One client covers both sandbox and production.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), open
   **OAuth consent screen**. With Google Workspace, choose user type **Internal**, so Google turns
   away anyone outside your organization before the allowlist is even consulted. Choose External
   only if someone you will allow has no Workspace account. The default scopes (`openid`,
   `email`, `profile`) need no verification.
2. **Credentials → Create credentials → OAuth client ID**, type **Web application**, with the
   authorized redirect URI `https://HOST/auth/callback`.
3. Keep the client ID and secret for the install step.

**An Intuit developer app.** At <https://developer.intuit.com>, **Dashboard → Create an app →
QuickBooks Online and Payments**.

- Name it without "QuickBooks", "QB", "QBO", "Intuit", "quick" or anything that sounds like them;
  the portal rejects such names.
- Choose the `com.intuit.quickbooks.accounting` scope only. Scopes can be added later but never
  removed.
- Under the **Development** settings, add the redirect URI `https://HOST/qbo/callback`. The
  Development and Production lists are separate, and the sandbox keys only accept addresses on the
  Development one.
- Copy the **development** Client ID and Client Secret.
- Make sure a sandbox company exists (the **Sandbox** menu in the portal).

## 1. Install

Both routes run the same image with the same settings. Pick one.

### Helm, on Kubernetes

You need an ingress controller that serves `HOST` to the internet with TLS terminated in front of
it, or at the ingress. The chart is published at `oci://ghcr.io/tight-line/charts/ledger-mcp`.

**Values.** Copy [values-example.yaml](../deploy/helm/ledger-mcp/values-example.yaml) somewhere
outside this repository, since it names your hostname and your people, and fill it in:

| Key | |
|---|---|
| `kubeContext`, `namespace` | Where it runs. Read by the scripts in `deploy/`, ignored by the chart. |
| `publicUrl` | `https://HOST`, no path. |
| `allowedEmails` | Who may use it: addresses, or `*@domain`. |
| `adminEmails` | Who may connect or disconnect the company. Exact addresses only. |
| `site.*` | The app's name, and the operator, contact, governing law, venue, hosting location and effective date the legal pages state. All required. |
| `quickbooks.environment` | `sandbox` for now. |
| `ingress.className` | The ingress class that serves the internet. |
| `networkPolicy.ingressNamespace` | The namespace your ingress controller runs in. |

[values.yaml](../deploy/helm/ledger-mcp/values.yaml) documents everything else.

**The Secret.** The chart never handles credentials; they live in a Secret named `ledger-mcp`
that you create first. From a checkout of this repository:

```sh
deploy/secret.sh path/to/values.yaml
```

It prompts for the Google and Intuit IDs and secrets without echoing them, generates `SEAL_KEY`
itself, and writes nothing to disk. Re-running it keeps any value you leave blank. Or create it
any way you like, as long as it has these keys:

```
SEAL_KEY                   openssl rand -base64 32
OIDC_CLIENT_ID             from Google
OIDC_CLIENT_SECRET
QUICKBOOKS_CLIENT_ID       from Intuit
QUICKBOOKS_CLIENT_SECRET
```

**Install.**

```sh
helm upgrade --install ledger-mcp oci://ghcr.io/tight-line/charts/ledger-mcp --version 0.1.2 \
  -n ledger-mcp -f path/to/values.yaml --wait
```

Or, from a checkout, `deploy/deploy.sh path/to/values.yaml`. It refuses to start unless the
image is pullable and the Secret has every key, and afterwards fetches `/healthz`, `/eula` and
`/privacy` through `HOST`.

### `docker compose up`, on one host

You need a host with ports 80 and 443 open to the internet and a DNS record pointing `HOST` at it.
Caddy, in the same stack, obtains and renews the certificate.

```sh
cd deploy/compose
cp .env.example .env
$EDITOR .env          # every value; SEAL_KEY from: openssl rand -base64 32
docker compose up -d
docker compose logs ledger | grep listening
```

`.env` holds the secrets. Keep it out of version control and readable only by you.

### Check it

- `https://HOST/` shows the start page, and `https://HOST/eula` and `https://HOST/privacy` show
  your terms with your details in them.
- The `listening` log line names the tool count, the allowlists and `qboEnvironment: sandbox`.

## 2. Register and validate against a sandbox company

**Connect the company.** Open `https://HOST/`, **Sign in** with an address in `adminEmails`, and
choose **Connect to QuickBooks**. Sign in to Intuit, and pick the sandbox company. If Intuit
greets you by a name that is not yours, choose **Not You?** first. The start page then shows
**Connected** and the realm ID.

If Intuit says the `redirect_uri` is invalid, `https://HOST/qbo/callback` is missing from the
Development redirect URIs, or differs from it by a character.

**Connect an assistant.**

- **Claude** (web, desktop, mobile): **Settings → Connectors → Add custom connector**, URL
  `https://HOST/mcp`.
- **Claude Code**: `claude mcp add --transport http ledger https://HOST/mcp`, then `/mcp` to sign in.

Either one opens a browser: sign in, check the consent page, which names the assistant and where
access is going, and choose **Allow**. Then ask for the company's details, or a profit and loss
report.

**Validate what Intuit will ask about.** The production questionnaire asks whether you tested
these, and an app that answers no is rejected:

1. **Disconnect from your server.** **Disconnect** on the start page. You arrive on the
   *Disconnected* page, and a tool call now says QuickBooks is not connected.
2. **Reconnect.** **Connect to QuickBooks** again; tools work again.
3. **Disconnect from inside QuickBooks.** In the sandbox company, find the connected apps list
   (**Settings → Apps**, or similar), and disconnect yours. Intuit sends you to
   `https://HOST/qbo/disconnected`. The next tool call reports that the authorization was
   revoked; reconnect from the start page.

## 3. Switch to production

**Apply for production keys.** In the Intuit portal, **Keys & credentials → Production**. Fill in
the app details and the App Assessment Questionnaire using
[intuit-production.md](intuit-production.md), which lists every field with the address that goes
in it and notes what is true of this server for each question. Intuit issues the production keys
after approval.

**Then:**

1. Add `https://HOST/qbo/callback` to the **Production** redirect URIs.
2. Set the environment to production: `quickbooks.environment: production` in your values file,
   or `QUICKBOOKS_ENVIRONMENT=production` in `.env`.
3. Replace the Intuit keys with the production ones: `deploy/secret.sh path/to/values.yaml` and
   press Enter at the Google prompts to keep those, or edit `.env`.
4. Apply: the same `helm upgrade` (or `deploy/deploy.sh`), or `docker compose up -d`.
5. On the start page, **Connect to QuickBooks** and choose the real company. This replaces the
   sandbox connection; production keys cannot use it anyway.
6. If the development secret was ever pasted somewhere it should not have been, rotate it in the
   portal now.

Intuit meters reads: every app, private ones included, is on the free Builder tier, with 500,000
read, query and report calls a month, after which reads are blocked rather than billed. Writes are
not metered.

Day-to-day running (adding people, revoking access, audit logs, read-only mode, upgrades) is in
[operations.md](operations.md).
