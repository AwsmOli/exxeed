/**
 * The tools, served over MCP.
 *
 * The app does not call a model (SPEC.md §2 still holds). It listens, on this
 * machine only, and an assistant the driver runs — Claude, ChatGPT, a local
 * model — connects and asks. Which assistant, and how it hears and speaks, is
 * not this file's business.
 *
 * Loopback and a token, both. Loopback keeps the rest of the network out; the
 * token keeps out everything else on the machine that can open a socket to
 * localhost, which includes any web page in any browser. A page can send a
 * request here but cannot know the token.
 *
 * Stateless: every request gets its own server and transport, so there is no
 * session to expire, leak or get out of step when the app restarts under a
 * client that is still connected.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { AUTHORING_INSTRUCTIONS, AUTHORING_READ_ONLY, AUTHORING_TOOLS, type AuthoringHost } from "./authoring.js";
import { NoLiveData, type AssistantState } from "./state.js";
import { TOOLS, type AssistantTool, type Tool } from "./tools.js";

export const MCP_PATH = "/mcp";

/** Loopback only. Never 0.0.0.0: the token is not meant to be the only wall. */
const HOST = "127.0.0.1";

export interface AssistantServerOptions {
  readonly state: AssistantState;
  /** Required on every request, as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** 0 picks a free port — what the tests use. */
  readonly port: number;
  readonly tools?: readonly AssistantTool[];
  /**
   * The app's importer and tracer. Given, the authoring tools are served too;
   * left out, an assistant can ask about the race and change nothing.
   */
  readonly authoring?: AuthoringHost;
  /** Called once per tool call, for the log. */
  readonly onCall?: (name: string, ok: boolean) => void;
}

export interface AssistantServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function register<Ctx>(
  mcp: McpServer,
  options: AssistantServerOptions,
  tool: Tool<Ctx>,
  ctx: Ctx,
  readOnly: boolean,
): void {
  mcp.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: readOnly, openWorldHint: false },
    },
    async (args: Record<string, unknown>) => {
      try {
        const reply = await tool.run(ctx, args);
        options.onCall?.(tool.name, true);
        const data = Object.keys(reply.data).length === 0 ? "" : `\n\n${JSON.stringify(reply.data)}`;
        return {
          content: [
            { type: "text" as const, text: `${reply.summary}${data}` },
            ...(reply.images ?? []).map((image) => ({
              type: "image" as const,
              data: image.base64,
              mimeType: image.mimeType,
            })),
          ],
        };
      } catch (error) {
        options.onCall?.(tool.name, false);
        // "No live session" is an answer, and the one the driver should hear.
        // So is the app's own "yt-dlp is not installed". Either way the reason
        // is said plainly rather than hidden behind a protocol error.
        const message =
          error instanceof NoLiveData
            ? error.message
            : `Exxeed could not do that: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}

function buildMcp(options: AssistantServerOptions): McpServer {
  const mcp = new McpServer(
    { name: "exxeed", version: "0.1.0" },
    options.authoring === undefined ? {} : { instructions: AUTHORING_INSTRUCTIONS },
  );

  for (const tool of options.tools ?? TOOLS) register(mcp, options, tool, options.state, true);
  if (options.authoring !== undefined) {
    for (const tool of AUTHORING_TOOLS) {
      register(mcp, options, tool, options.authoring, AUTHORING_READ_ONLY.has(tool.name));
    }
  }

  return mcp;
}

function authorised(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handle(options: AssistantServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  if (path !== MCP_PATH) return refuse(res, 404, "Not found");
  if (!authorised(req, options.token)) {
    return refuse(res, 401, "Missing or wrong token", { "www-authenticate": "Bearer" });
  }
  // Stateless, so there is no stream to open with GET and no session to DELETE.
  if (req.method !== "POST") return refuse(res, 405, "Method not allowed", { allow: "POST" });

  const mcp = buildMcp(options);
  // No `sessionIdGenerator` is what makes the transport stateless.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  // The SDK's own transport, cast to the SDK's own interface: its optional
  // callbacks are declared `T | undefined` on the class and `?: T` on the
  // interface, which only `exactOptionalPropertyTypes` (SPEC.md §3) tells apart.
  await mcp.connect(transport as Transport);
  await transport.handleRequest(req, res);
}

export function startAssistantServer(options: AssistantServerOptions): Promise<AssistantServer> {
  if (options.token.length < 16) {
    return Promise.reject(new Error("assistant token is too short to be a secret"));
  }

  const http: Server = createServer((req, res) => {
    handle(options, req, res).catch((error: unknown) => {
      if (!res.headersSent) refuse(res, 500, error instanceof Error ? error.message : String(error));
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, HOST, () => {
      http.off("error", reject);
      const { port } = http.address() as AddressInfo;
      resolve({
        port,
        url: `http://${HOST}:${port}${MCP_PATH}`,
        close: () =>
          new Promise<void>((done) => {
            http.close(() => done());
            // A client holding a keep-alive socket would otherwise hold the
            // port open until it let go.
            http.closeAllConnections();
          }),
      });
    });
  });
}
