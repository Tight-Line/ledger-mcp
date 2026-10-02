# Ledger Bridge

A permanent, public home for a QuickBooks Online MCP server, open only to the people you name.

Intuit publishes an official [QuickBooks Online MCP server](https://github.com/intuit/quickbooks-online-mcp-server),
but it is a local program: everyone who wants their AI assistant to read the books runs their own
copy, holding their own copy of the company's credentials, after a browser handshake that Intuit
only allows against a public HTTPS address once you use real (production) data. For one developer
that is a chore. For a team it means a refresh token spread across laptops, that rotates daily and
breaks whichever copy did not get the new one.

Ledger Bridge runs Intuit's server once, somewhere public, and lets everyone on your allowlist use
it from any MCP client: Claude on the web, desktop or phone, Claude Code, or anything else that
speaks the protocol. One deployment, one connected QuickBooks company, any number of people.

- **Intuit's server, unmodified.** All 142 tools it registers, pinned to a commit and imported as
  a dependency. Ledger Bridge adds the remote transport, sign-in and the connection flow around it.
- **Sign in with Google**, or any OpenID Connect provider, through the standard MCP authorization
  flow that Claude and other clients already speak. No passwords, nothing to provision per client.
- **An allowlist** of addresses or `*@domain`, checked on every request.
- **The pages Intuit requires before it issues production keys**: a start page, an end-user
  license agreement, a privacy policy and a disconnect page, filled in with your details.
- **Install with Helm or `docker compose up`.**

Start with the [quickstart](docs/quickstart.md).

## How safe is "fairly safe"

The server is on the internet, so everything here assumes strangers can reach every address it
answers on. What stands between them and the books:

- **Only verified addresses on the allowlist get in.** The identity provider must vouch for the
  address, and the allowlist is consulted on every request, not just at sign-in, so removing
  someone stops them at their next request whatever tokens they hold.
- **A link cannot steal a sign-in.** Anyone may register an MCP client, which is how assistants
  connect without setup, but a client may only ask for its code to be sent to Claude's callback or
  to the user's own machine, and nothing is issued until the person approves a consent page naming
  the client and where access is going. Each sign-in is bound to the browser that started it.
- **Only named administrators connect the company.** Connecting decides which company everyone's
  tools act on, so it takes an exact address on a separate list; wildcards are refused.
- **Nothing is stored that does not need to be.** There is no database. Everything the server
  issues is encrypted and signed with one key, and expires: access tokens after an hour, a sign-in
  after 90 days at most. The QuickBooks refresh token, the one long-lived secret, sits on a volume.
- **The container is locked down**: non-root, read-only filesystem, no capabilities, and on
  Kubernetes a NetworkPolicy allowing only the ingress controller in and only DNS and public HTTPS
  out. Upstream's ability to read local files into attachments is switched off.

What it does **not** do, so you can decide whether it is enough:

- **Everyone on the allowlist has the same access.** There is one QuickBooks connection, and every
  tool call goes through it with that connection's permissions. There are no per-person roles. If
  someone should only read, make the whole deployment read-only with the `disable*` switches, or
  run a second deployment.
- **One token cannot be revoked early.** Removing the person, or rotating the key (which signs
  everyone out), are the two levers.
- **It is as trustworthy as the assistant you connect.** Records go to that assistant, and an
  assistant can be talked into things by what it reads. Keep writes disabled unless you need them.
- **It does not audit beyond its own log.** Each tool call logs who made it, in the container log.

## Configuration

The chart's [values.yaml](deploy/helm/ledger-mcp/values.yaml) and the compose
[.env.example](deploy/compose/.env.example) document every setting. In brief:

| Variable | |
|---|---|
| `PUBLIC_URL` | The public origin, e.g. `https://ledger.example.com`. Must be https. |
| `ALLOWED_EMAILS` | Comma-separated addresses or `*@domain`. Required; empty refuses to start. |
| `ADMIN_EMAILS` | Exact addresses who may connect or disconnect the company. |
| `CLIENT_REDIRECT_URIS` | Where an MCP client may have its code sent: exact https URLs, or `loopback`. Default: Claude's callback and loopback. |
| `SEAL_KEY` | 32 random bytes, base64. Secret. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The identity provider. Google by default. |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT` | The Intuit app's keys, and `sandbox` or `production` to match them. |
| `QUICKBOOKS_TOKEN_STORE_PATH` | Where the refresh token is kept. On a volume. |
| `QUICKBOOKS_DISABLE_WRITE`, `_UPDATE`, `_DELETE` | Upstream's switches. Read tools are always on. |
| `APP_NAME`, `OPERATOR_NAME`, `CONTACT_EMAIL`, `LEGAL_EFFECTIVE_DATE`, `GOVERNING_LAW`, `GOVERNING_VENUE`, `HOSTING_LOCATION` | What the public pages and legal terms say. All but the name are required. |

## Development

```sh
npm ci
npm test        # the flow tests run a real sign-in against a fake OpenID Connect provider
```

The tests also pin the places this repository relies on upstream internals: the tool list it reads
from upstream's compiled `index.js`, the token fields on upstream's client that connecting a
company updates, and the interactive OAuth fallback it replaces. Bump upstream by changing the
commit in `package.json`; if any of those have moved, `npm test` says so, and so does the server at
startup.

A push to `main` publishes an image tagged `sha-<short>`. A `v*` tag publishes the image under
that version and the chart at `oci://ghcr.io/tight-line/charts/ledger-mcp`, with the chart's
version, its `appVersion` and `package.json` required to agree.

### Known residual

`npm audit --omit=dev` reports one moderate advisory: `decode-uri-component` under
`intuit-oauth`'s `query-string`. Its only fixed release is ESM-only and cannot be loaded by that
CommonJS caller, and it is reachable only from the QuickBooks callback, which requires an
administrator's session. The two high advisories under `node-quickbooks` are closed by the
`overrides` in `package.json`, which mirror upstream's own (npm honours overrides only in the root
package, so upstream's do not apply when it is a dependency).

## License

MIT, for the code in this repository; see [LICENSE](LICENSE). This repository contains no
upstream code. The image includes Intuit's server unmodified, under its own license (the Apache
License 2.0, per its LICENSE file), and [NOTICE](NOTICE) explains how that is carried.

Ledger Bridge is made by [Tight Line](https://www.tightlinesoftware.com). QuickBooks and Intuit are
trademarks of Intuit Inc. This project is not affiliated with or endorsed by Intuit, and its name
avoids Intuit's marks because Intuit's developer rules require it.
