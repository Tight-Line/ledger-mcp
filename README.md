# ledger-mcp

Intuit's [QuickBooks Online MCP server](https://github.com/intuit/quickbooks-online-mcp-server),
served remotely over HTTPS, so an AI assistant such as Claude can reach one QuickBooks Online
company from anywhere, and only for the people you name.

Upstream is a local stdio server: each user runs it on their own machine, with their own copy of
the company's refresh token, after a browser handshake that Intuit only allows against a public
HTTPS redirect in production. This repository wraps it, unmodified, in what a shared deployment
needs:

- **Streamable HTTP** at `/mcp`, so it works as a Claude custom connector and with
  `claude mcp add --transport http`.
- **MCP OAuth** (the authorization flow MCP clients already speak: discovery, dynamic client
  registration, PKCE), with sign-in delegated to Google or any OpenID Connect provider, and a
  consent page naming who is asking. Clients may only register Claude's callback or loopback
  redirects, so an `/authorize` link from a stranger cannot deliver a code anywhere they control.
- **An email allowlist**, exact addresses or `*@domain`, checked on every request. Removing a
  person ends their access at their next request.
- **A browser flow to connect the company** at `/qbo/connect`, for named administrators only,
  with the refresh token kept on a volume and rotated by upstream as it always is.
- **The public pages Intuit requires** before it issues production keys: a launch page, an
  end-user license agreement, a privacy policy and a disconnect page.
- **An audit line per tool call**, naming the person, because everyone acts through the same
  QuickBooks connection.

All 142 tools upstream registers are served, and the read/write/update/delete switches it offers
are exposed as chart values.

## How it fits together

```
Claude ──/mcp + bearer──▶ ledger-mcp ──upstream tools──▶ QuickBooks Online API
   │                         │  ▲
   └─/authorize, /token──────┘  │ verified email
                                │
                      Google (or any OIDC IdP)
```

Every value the server issues (client IDs, codes, access and refresh tokens, sessions) is
AES-GCM sealed with one key, `SEAL_KEY`, so the server keeps no database and a restart signs
nobody out. The trade is revocation: a single token cannot be revoked before it expires (one hour
for access, thirty days for refresh), but taking someone off the allowlist stops them at once,
and rotating `SEAL_KEY` invalidates everything.

Only one replica runs, deliberately. Intuit invalidates the previous refresh token every time it
rotates, so two processes refreshing from one token store race and the loser holds a dead token.

## Install

[docs/install.md](docs/install.md) covers it end to end: the Google OAuth client, the Intuit app
(sandbox first, then production), the Secret, the deploy, connecting the company and giving
people access. [docs/intuit-production.md](docs/intuit-production.md) is the field-by-field
answer sheet for Intuit's production checklist.

The short version, with a copy of `deploy/helm/ledger-mcp/values-example.yaml` kept outside
the repository:

```sh
deploy/secret.sh path/to/values.yaml           # credentials, prompted
deploy/deploy.sh path/to/values.yaml sha-abc1234
```

Then an administrator opens the site, signs in and chooses **Connect to QuickBooks**.

## Configuration

The chart sets all of these; `values.yaml` documents each.

| Variable | |
|---|---|
| `PUBLIC_URL` | The public origin, e.g. `https://ledger.example.com`. Must be https. |
| `ALLOWED_EMAILS` | Comma-separated addresses or `*@domain`. Required; empty refuses to start. |
| `ADMIN_EMAILS` | Comma-separated exact addresses who may connect or disconnect the company. |
| `CLIENT_REDIRECT_URIS` | Redirects an MCP client may register: exact https URLs, or `loopback`. Default: Claude's callback and loopback. |
| `SEAL_KEY` | 32 random bytes, base64. Secret. |
| `OIDC_ISSUER` | Default `https://accounts.google.com`. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The identity provider's web client. Secret. |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | From the Intuit Developer Portal. Secret. |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` or `production`; must match the keys. |
| `QUICKBOOKS_TOKEN_STORE_PATH` | Where upstream keeps the refresh token. On a volume. |
| `QUICKBOOKS_DISABLE_WRITE`, `_UPDATE`, `_DELETE` | Upstream's switches. Read tools are always on. |
| `CONTACT_EMAIL`, `APP_NAME`, `OPERATOR_NAME`, `LEGAL_EFFECTIVE_DATE`, `GOVERNING_LAW`, `GOVERNING_VENUE` | What the public pages and legal text say. |

`create_attachable`'s `file_path` source is disabled here on purpose: in upstream it reads the
server's own disk, which suits a local stdio process and would let any caller upload this
container's files. Base64 and https URL sources still work.

## Development

```sh
npm ci
npm test        # 51 tests; the flow tests run a real sign-in against a fake OIDC provider
```

The tests also pin the two places this repo relies on upstream internals: the tool list it reads
out of upstream's compiled `index.js`, and the token fields on upstream's client that connecting
a company has to update. Bump upstream by changing the commit in `package.json`; if either has
moved, `npm test` says so, and so does the server at startup.

## Known residual

`npm audit --omit=dev` reports one moderate advisory: `decode-uri-component` under
`intuit-oauth`'s `query-string`. Its only fixed release is ESM-only and cannot be loaded by that
CommonJS caller, and it is reachable only from the QuickBooks callback, which requires an
administrator's session. The two high advisories under `node-quickbooks` are closed by the
`overrides` in `package.json`, which mirror upstream's own (npm honours overrides only in the root
package, so upstream's do not apply when it is a dependency).

## License

MIT, for the code in this repository; see [LICENSE](LICENSE). This repository contains no
upstream code. The image includes Intuit's server unmodified, under its own license (Apache
License 2.0 per its LICENSE file), and [NOTICE](NOTICE) explains how that is carried.

QuickBooks and Intuit are trademarks of Intuit Inc. This project is not affiliated with or
endorsed by Intuit, and its name, the app name and the hostname avoid Intuit's marks because
Intuit's developer rules require it.
