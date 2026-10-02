# Installing ledger-mcp

This puts one deployment on the internet, connected to one QuickBooks Online company, usable by
the people you name.

Expect two passes. Intuit only issues production keys after its App Assessment Questionnaire,
and the questionnaire asks whether you tested connecting, disconnecting and reconnecting against
a sandbox company. Answering "no" gets the app rejected. So the first deploy runs against
sandbox keys, and production keys come later.

## What you need

- `kubectl` and `helm` (4.x) with a context for the cluster, and `docker` for the pullability check.
- A public hostname that reaches the cluster's ingress over HTTPS, and an ingress class that
  serves the internet. **Do not put "qbo", "quickbooks" or "intuit" in it.** Intuit's trademark rules forbid its marks
  in domain names.
- An admin on the Google Workspace (or another OpenID Connect provider).
- An Intuit Developer account.

## 1. The values file

Copy `deploy/helm/ledger-mcp/values-example.yaml` to somewhere outside this repository (it names
your hostname and your people) and set:

| Key | |
|---|---|
| `kubeContext`, `namespace` | Where it runs. Read by the scripts, not by the chart. |
| `publicUrl` | `https://<hostname>`, with no path. |
| `allowedEmails` | Who may use it: addresses, or `*@domain`. |
| `adminEmails` | Who may connect or disconnect the company. Exact addresses only. |
| `site.contactEmail` | Shown on every page and in the legal text. |
| `quickbooks.environment` | `sandbox` for now. |
| `ingress.className` | The ingress class that serves the internet. |
| `networkPolicy.ingressNamespace` | The namespace your ingress controller runs in. |

If whatever sits in front of the ingress controller does not pass `X-Forwarded-For` through, every
client looks like the same address and the SDK's rate limits become one bucket shared by everyone.
Check with a few `GET /authorize` requests from two different networks: the `ratelimit-remaining`
header should count down separately for each.

The rest of this guide calls that hostname `HOST`.

## 2. The Google OAuth client

This handles sign-in only, so one client serves both the sandbox and the production phase.

In the Google Cloud console, for a project in the Workspace:

1. **APIs & Services → OAuth consent screen.** User type **Internal**. Google then refuses anyone
   outside the Workspace before the allowlist is even consulted. Choose External only if someone
   on the allowlist has no Workspace account. The scopes needed are `openid`, `email` and
   `profile`, which require no verification.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID.** Type **Web
   application**. Authorized redirect URI: `https://HOST/auth/callback`. No JavaScript origins
   are needed.
3. Keep the client ID and secret for step 4. Do not paste them into chat, a ticket or a file.

## 3. The Intuit app, sandbox keys

At <https://developer.intuit.com>, **Dashboard → Create an app → QuickBooks Online and Payments**.

- **Name:** no "QuickBooks", "QB", "QBO", "Intuit" or similar; the portal rejects them. Tight
  Line's is *Tight Line Ledger Bridge*.
- **Scope:** `com.intuit.quickbooks.accounting` only. Scopes can be added later and never removed.
- **Keys & credentials → Development → Redirect URIs:** add `https://HOST/qbo/callback`.
- Copy the **development** Client ID and Client Secret.
- Under **Sandbox**, make sure a sandbox company exists.

## 4. The Secret

```sh
deploy/secret.sh path/to/values.yaml
```

It creates the namespace if needed, then prompts for the four credentials without echoing them.
Enter keeps a value already in the cluster, so re-running it to change one credential is safe.
It generates `SEAL_KEY` itself, once, and keeps it after that. Nothing is written to disk.

## 5. Deploy

Images are built by the Release workflow on every push to `main` and tagged `sha-<short>`. Take
the tag from the workflow summary, then:

```sh
deploy/deploy.sh path/to/values.yaml sha-abc1234
```

It refuses to start unless the image is anonymously pullable and the Secret has every key. After
Helm finishes, it prints the pod's startup line (tool count, allowlist, environment) and fetches
`/healthz`, `/eula` and `/privacy` through the real hostname. Expect three 200s.

The first time, ghcr may create the package as private even though the repository is public. If
the pullability check fails right after a successful Release run, open the package's settings on
GitHub and set its visibility to Public.

## 6. Connect the sandbox company and test

1. Open `https://HOST/`, **Sign in** with an admin address, and choose **Connect to QuickBooks**.
   Sign in to Intuit and pick the sandbox company. The page then shows *Connected* and the realm ID.
2. Add the server to Claude: **Settings → Connectors → Add custom connector**, URL
   `https://HOST/mcp`. Or in Claude Code: `claude mcp add --transport http ledger https://HOST/mcp`,
   then `/mcp` to sign in. Ask for the company info, or a profit and loss report.
3. Test what the questionnaire asks about, and note that you did:
   - **Disconnect from this site:** **Disconnect** on the start page. Intuit revokes the grant;
     a tool call now reports that QuickBooks is not connected.
   - **Reconnect:** **Connect to QuickBooks** again.
   - **Disconnect from QuickBooks' side:** in the sandbox company, **Settings → Apps → Connected
     apps** (wording varies), disconnect. Intuit sends the browser to `https://HOST/qbo/disconnected`.
     The next tool call fails with a re-authorize error, which is correct; reconnect from the start
     page.

## 7. Production keys

Follow [intuit-production.md](intuit-production.md), which has every field and the URL that goes
in it. When Intuit shows the production Client ID and Secret:

1. Rotate the development secret in the portal if it was ever pasted anywhere it should not have been.
2. Add `https://HOST/qbo/callback` under **Production → Redirect URIs**.
3. Set `quickbooks.environment: production` in the values file.
4. `deploy/secret.sh <values-file>`, and enter the **production** QuickBooks ID and secret
   (Enter keeps the Google ones).
5. `deploy/deploy.sh <values-file> <tag>`.
6. On the start page, **Connect to QuickBooks** again and choose the real company. The sandbox
   grant is replaced; a production key cannot use it anyway.

Under Intuit's App Partner Program every app, private ones included, sits on the free Builder
tier: 500,000 read, query and report calls a month, after which reads are blocked rather than
billed. Writes are not metered.

## Day to day

**Giving someone access.** Add them to `allowedEmails` and run `deploy.sh`. The pod restarts,
since the list is configuration. They then add the connector and sign in.

**Taking access away.** Remove them and run `deploy.sh`. Their next request is refused, whatever
tokens they hold. To end every session for everyone at once, which is the only way to revoke
tokens before they expire: `ROTATE_SEAL_KEY=1 deploy/secret.sh <values-file>`, then `deploy.sh`.
Everyone signs in again; the QuickBooks connection is unaffected.

**Who did what.** Every tool call logs a line with the person's address:

```sh
kubectl --context <context> -n <namespace> logs deploy/ledger-mcp | grep '"event":"tool_call"'
```

Pod logs are rotated by the kubelet and are not shipped anywhere, so this is recent history only.

**Read-only.** Set `quickbooks.disableWrite`, `disableUpdate` and `disableDelete` to `true` and
redeploy. Those tools then disappear for every user.

**The connection.** The refresh token is good for 100 days without use, and each refresh resets
that. Upstream refreshes on demand and writes the rotated token to the volume, so a deployment
that is used at least every few months never needs reconnecting, until Intuit's five-year hard
limit (late 2028 at the earliest). If the volume is lost, reconnect from the start page.

**Upgrading upstream.** Change the commit in `package.json`'s `@qboapi/qbo-mcp-server` entry,
run `npm install` and `npm test`, and merge. The tests and the server's own startup checks fail
loudly if upstream has moved anything this server depends on.

## Uninstalling

`helm -n <namespace> uninstall ledger-mcp` leaves the volume holding the token, on purpose. To
end the connection properly, choose **Disconnect** on the start page first, which revokes the
grant at Intuit. Delete the PVC afterwards if nothing should remain.
