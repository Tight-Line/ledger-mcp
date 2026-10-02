# Operations

Running a deployment once it is up. Setting one up is in [quickstart.md](quickstart.md).

"Apply" below means whichever you installed with: `helm upgrade` with the same values file (or
`deploy/deploy.sh`), or `docker compose up -d` after editing `.env`.


## People

**Giving someone access.** Add them to `allowedEmails` (`ALLOWED_EMAILS` in `.env`) and apply.
The server restarts, since the list is configuration. They then add the connector and sign in.

**Taking access away.** Remove them and apply. Their next request is refused, whatever tokens
they hold. To end every session for everyone at once, which is the only way to revoke tokens
before they expire, replace `SEAL_KEY` (`ROTATE_SEAL_KEY=1 deploy/secret.sh <values-file>`, or a
new value in `.env`) and apply. Everyone signs in again; the QuickBooks connection is unaffected.

A sign-in lasts at most 90 days, however often the assistant refreshes it.

## Records

**Who did what.** Every tool call logs a line with the person's address:

```sh
kubectl -n <namespace> logs deploy/ledger-mcp | grep '"event":"tool_call"'
docker compose logs ledger | grep '"event":"tool_call"'
```

Container logs are rotated and are recent history only. Ship them somewhere if you need more.

## QuickBooks

**Read-only.** Set `quickbooks.disableWrite`, `disableUpdate` and `disableDelete` to `true` and
apply. Those tools then disappear for every user.

**The connection.** The refresh token is good for 100 days without use, and each refresh resets
that. Upstream refreshes on demand and writes the rotated token to the volume, so a deployment
that is used at least every few months never needs reconnecting, until Intuit's five-year hard
limit (late 2028 at the earliest). If the volume is lost, reconnect from the start page.

**Rate limits.** Registration, authorization and token requests are rate-limited per client
address. If whatever sits in front of the server replaces `X-Forwarded-For` with its own address
instead of passing it on, every client shares one bucket, and a stranger can exhaust it for
everyone. Check with a few `GET https://HOST/authorize` requests from two different networks: the
`ratelimit-remaining` header should count down separately for each.

## Upgrading

**This server.** Install a newer chart version, or set a newer `LEDGER_VERSION` in `.env`, and
apply.

**Upstream, as a maintainer of this repository.** Change the commit in `package.json`'s `@qboapi/qbo-mcp-server` entry,
run `npm install` and `npm test`, and merge. The tests and the server's own startup checks fail
loudly if upstream has moved anything this server depends on.

## Uninstalling

Choose **Disconnect** on the start page first, which revokes the grant at Intuit. Then
`helm -n <namespace> uninstall ledger-mcp`, which leaves the volume holding the token on purpose
(delete the PVC if nothing should remain), or `docker compose down -v`.
