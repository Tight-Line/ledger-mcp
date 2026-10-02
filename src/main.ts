import { loadConfig } from "./config.js";

// Order matters: upstream reads QUICKBOOKS_* from process.env when its modules are first
// imported, so everything it needs is in the environment before loadUpstream() runs. The
// imports below are dynamic for the same reason.
async function main(): Promise<void> {
  const config = loadConfig();
  const { loadUpstream, prepareUpstreamEnvironment } = await import("./upstream.js");
  const { OidcClient } = await import("./oidc.js");
  const { QboConnection } = await import("./qbo-connection.js");
  const { createApp } = await import("./app.js");

  prepareUpstreamEnvironment(config);
  const upstream = await loadUpstream();
  const oidc = await OidcClient.discover({
    ...config.oidc,
    redirectUri: new URL("/auth/callback", config.publicUrl).href,
  });
  const connection = new QboConnection(config, upstream);
  const app = createApp({ config, oidc, upstream, connection });

  app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        event: "listening",
        port: config.port,
        publicUrl: config.publicUrl.origin,
        tools: upstream.tools.length,
        qboEnvironment: config.qbo.environment,
        qboConnected: connection.isConnected(),
        users: config.users.describe(),
        admins: config.admins.describe(),
      }),
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
