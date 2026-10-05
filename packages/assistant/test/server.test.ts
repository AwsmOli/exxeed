import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { AssistantState, startAssistantServer, TOOLS, type AssistantServer } from "@exxeed/assistant";

import { view } from "./fixture.js";

const TOKEN = "test-token-0123456789abcdef";

let server: AssistantServer | null = null;
let client: Client | null = null;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = null;
  server = null;
});

async function connect(state: AssistantState, calls: string[] = []): Promise<Client> {
  server = await startAssistantServer({
    state,
    token: TOKEN,
    port: 0,
    onCall: (name, ok) => calls.push(`${name}:${ok ? "ok" : "error"}`),
  });
  client = new Client({ name: "test", version: "0" });
  // Cast for the same reason as in server.ts: the SDK's class and interface
  // disagree only under `exactOptionalPropertyTypes`.
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }) as Transport,
  );
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join("");

describe("the MCP server", () => {
  it("lists every tool, all marked read-only", async () => {
    const c = await connect(new AssistantState());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("answers a tool call from live state", async () => {
    const state = new AssistantState();
    state.onRace(0, view());
    const calls: string[] = [];
    const c = await connect(state, calls);

    const result = await c.callTool({ name: "get_fuel", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("You need to stop and add at least 7.5 litres.");
    expect(calls).toEqual(["get_fuel:ok"]);
  });

  it("applies a tool's argument defaults", async () => {
    const state = new AssistantState();
    state.onRace(0, view());
    const c = await connect(state);
    const result = await c.callTool({ name: "get_gap_trend", arguments: {} });
    expect(text(result)).toContain("seconds behind");
    expect(text(result)).toContain("seconds ahead");
  });

  it("says there is no session instead of failing", async () => {
    const calls: string[] = [];
    const c = await connect(new AssistantState(), calls);
    const result = await c.callTool({ name: "get_weather", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("No live session: Exxeed is not connected to the sim.");
    expect(calls).toEqual(["get_weather:error"]);
  });

  it("listens on loopback only", async () => {
    await connect(new AssistantState());
    expect(server?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});

describe("without the token", () => {
  const post = (url: string, headers: Record<string, string>): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("refuses a request with none, or the wrong one", async () => {
    server = await startAssistantServer({ state: new AssistantState(), token: TOKEN, port: 0 });
    expect((await post(server.url, {})).status).toBe(401);
    expect((await post(server.url, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(server.url, { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await post(server.url, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("serves nothing off the one path", async () => {
    server = await startAssistantServer({ state: new AssistantState(), token: TOKEN, port: 0 });
    const res = await post(server.url.replace("/mcp", "/"), { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
  });

  it("will not start with a token too short to be a secret", async () => {
    await expect(startAssistantServer({ state: new AssistantState(), token: "short", port: 0 })).rejects.toThrow();
  });
});
