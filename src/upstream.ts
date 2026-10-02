import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";

// The one place this repo touches Intuit's server. Everything QuickBooks-specific -- the 145
// tools, their schemas, the API client, token refresh and rotation -- is upstream's, imported
// unmodified from the pinned commit in package.json. What this repo adds is the transport,
// the sign-in and the connect flow around it.
//
// Upstream ships a stdio server and no library entry point, so two things are reached for
// that it does not export as an API. Both are checked when the process starts, so an upstream
// change that moves them stops this server from starting instead of quietly serving fewer
// tools or a client that never sees a new token:
//
//   1. THE TOOL LIST. Upstream's dist/index.js is a list of `RegisterTool(server, X);` calls
//      in a main() that connects to stdio. It is read as text here and each named tool
//      imported from the file index.js imports it from. That set, and not every file in
//      dist/tools, is what upstream serves: several tool files exist and are deliberately
//      not registered (they are commented out in index.ts).
//
//   2. THE CLIENT'S TOKEN FIELDS. Upstream's QuickbooksClient reads its refresh token and
//      realm once, at import, from QUICKBOOKS_TOKEN_STORE_PATH. Connecting a company at
//      runtime therefore has to hand the new values to the live client as well as writing
//      the file, or every tool keeps reporting "not authorized" until a restart.

// The shape upstream's tools have (src/types/tool-definition.ts). Upstream compiles without
// declarations, so it is restated here and checked at load.
export interface ToolDefinition {
  name: string;
  description: string;
  schema: unknown;
  handler: (...args: any[]) => Promise<any>;
}

// The fields of upstream's QuickbooksClient this server writes. TypeScript-private there, so
// ordinary properties at runtime.
interface UpstreamClient {
  refreshToken?: string;
  realmId?: string;
  accessToken?: string;
  accessTokenExpiry?: Date;
  quickbooksInstance?: unknown;
  authInFlight?: Promise<unknown>;
  refreshInFlight?: Promise<unknown>;
  isAuthenticating?: boolean;
  startOAuthFlow?: () => Promise<void>;
}

export const NOT_AUTHORIZED_MESSAGE =
  "QuickBooks Online is not connected, or its authorization has expired or been revoked. An administrator must connect it again from this server's start page.";

export interface Upstream {
  dist: string;
  tools: ToolDefinition[];
  registerTool: (server: McpServer, tool: ToolDefinition) => void;
  setCredentials: (credentials: { refreshToken: string; realmId: string } | null) => void;
  credentials: () => { refreshToken?: string; realmId?: string };
}

const IMPORT_LINE = /^import \{ (\w+) \} from "(\.\/tools\/[\w.-]+\.js)";$/gm;
const REGISTER_LINE = /^\s*RegisterTool\(server, (\w+)\);$/gm;

function packageDir(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve("@qboapi/qbo-mcp-server/package.json"));
}

// Upstream is configured through process.env and reads it at import time, so this runs first.
export function prepareUpstreamEnvironment(config: Config): void {
  // Upstream's QBO client is built with this redirect URI. It only matters for refreshes,
  // which do not use it, but it should name the real one rather than upstream's localhost.
  process.env.QUICKBOOKS_REDIRECT_URI = config.qbo.redirectUri;

  // A file_path argument to create_attachable reads from the server's own disk. That suits
  // upstream's local stdio server, where the caller and the server share a filesystem, and not
  // this one: it would let any allowed caller upload this container's files, the token store
  // included, into QuickBooks. Pointed at a directory that does not exist, which upstream skips,
  // so no base directory remains and every file_path is refused. Inline base64 and https URL
  // sources still work.
  process.env.QUICKBOOKS_ATTACHABLE_BASE_DIR = "/nonexistent-attachable-base";

  // The PDF tool returns PDFs inline unless this names a directory to write them to, and a
  // directory inside this container is somewhere nobody can fetch them from.
  delete process.env.QBO_PDF_OUTPUT_DIR;
}

// Call prepareUpstreamEnvironment() first, with QUICKBOOKS_CLIENT_ID, _SECRET, _ENVIRONMENT and
// _TOKEN_STORE_PATH already in the environment.
export async function loadUpstream(): Promise<Upstream> {
  const dist = path.join(packageDir(), "dist");
  const index = readFileSync(path.join(dist, "index.js"), "utf8");

  const modules = new Map<string, string>();
  for (const [, name, file] of index.matchAll(IMPORT_LINE)) modules.set(name, file);

  const names = [...index.matchAll(REGISTER_LINE)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error("found no RegisterTool calls in upstream dist/index.js; has upstream changed shape?");
  }

  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = modules.get(name);
    if (!file) throw new Error(`upstream registers ${name} but does not import it from ./tools/`);
    const mod = await import(pathToFileURL(path.join(dist, file)).href);
    const tool = mod[name] as ToolDefinition | undefined;
    if (!tool || typeof tool.name !== "string" || typeof tool.handler !== "function" || !tool.schema) {
      throw new Error(`upstream ${file} does not export a tool definition named ${name}`);
    }
    if (seen.has(tool.name)) throw new Error(`upstream registers the tool ${tool.name} twice`);
    seen.add(tool.name);
    tools.push(tool);
  }

  const { RegisterTool } = await import(pathToFileURL(path.join(dist, "helpers", "register-tool.js")).href);
  if (typeof RegisterTool !== "function") throw new Error("upstream no longer exports RegisterTool");

  const { quickbooksClient } = await import(pathToFileURL(path.join(dist, "clients", "quickbooks-client.js")).href);
  const client = quickbooksClient as UpstreamClient | undefined;
  // Assigned in upstream's constructor even when undefined, so present as own properties.
  if (!client || !("refreshToken" in client) || !("realmId" in client)) {
    throw new Error("upstream QuickbooksClient no longer has refreshToken/realmId fields");
  }

  // NEVER START UPSTREAM'S OWN OAUTH FLOW. When upstream has no usable refresh token it falls
  // back to an interactive flow: in sandbox it binds port 8000 inside this pod, logs an
  // authorize URL and waits forever for a browser, leaving every later tool call queued behind a
  // promise that never settles, which survives even a reconnect. In production it throws a
  // message about ngrok. Here the remedy is always the same and lives in this server, so the
  // fallback is replaced with an error that names it, in both environments.
  if (typeof client.startOAuthFlow !== "function") {
    throw new Error("upstream QuickbooksClient no longer has startOAuthFlow; check how it re-authorizes");
  }
  client.startOAuthFlow = async () => {
    throw new Error(NOT_AUTHORIZED_MESSAGE);
  };

  return {
    dist,
    tools,
    registerTool: RegisterTool,
    setCredentials(credentials) {
      client.refreshToken = credentials?.refreshToken;
      client.realmId = credentials?.realmId;
      // Drop the cached access token and API instance so the next call refreshes against the
      // new grant rather than using one minted for the previous company.
      client.accessToken = undefined;
      client.accessTokenExpiry = undefined;
      client.quickbooksInstance = undefined;
      // And anything in flight against the old grant, so nothing waits on its outcome.
      client.authInFlight = undefined;
      client.refreshInFlight = undefined;
      client.isAuthenticating = false;
    },
    credentials: () => ({ refreshToken: client.refreshToken, realmId: client.realmId }),
  };
}
