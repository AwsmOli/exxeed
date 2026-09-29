/**
 * Sending the callout prompt to a model — any model.
 *
 * Every provider takes the same single prompt (prompt.ts) and returns text; the
 * reply parser does the rest. That is deliberate: the copy-and-paste path in
 * the importer is this exact function with a person in the middle, and keeping
 * the providers this thin is what keeps the two paths giving the same result.
 *
 * Where a provider can constrain its output to JSON it is asked to, because a
 * reply that does not parse is a wasted call. Nothing depends on it.
 *
 * SPEC.md §10 said "never call an LLM from the client". This is the authoring
 * side of the client, running on the author's key against the author's account;
 * the runtime still never calls a model (§2), and there is still no key of ours
 * in the bundle.
 */

import Anthropic from "@anthropic-ai/sdk";

import { CALLOUT_REPLY_JSON_SCHEMA } from "./prompt.js";

export type ProviderId = "anthropic" | "openai" | "gemini" | "openai-compatible";

export interface ProviderConfig {
  readonly provider: ProviderId;
  readonly model: string;
  readonly apiKey: string;
  /** openai-compatible only: e.g. http://localhost:11434/v1 for Ollama. */
  readonly baseUrl: string;
}

export interface ProviderInfo {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  readonly needsKey: boolean;
  readonly keyUrl: string | null;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic API)",
    defaultModel: "claude-opus-5-5",
    needsKey: true,
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI API)",
    defaultModel: "gpt-5",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    label: "Gemini (Google AI Studio)",
    defaultModel: "gemini-2.5-flash",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openai-compatible",
    label: "Other (OpenAI-compatible: Ollama, OpenRouter, LM Studio…)",
    defaultModel: "llama3.1",
    needsKey: false,
    keyUrl: null,
  },
];

async function anthropic(config: ProviderConfig, prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey });
  // Streamed: a long transcript and a full lap of callouts can outlast a
  // non-streaming request's timeout.
  const stream = client.beta.messages.stream({
    model: config.model,
    max_tokens: 32_000,
    // Routes a declined request to a model that will take it, rather than
    // returning nothing. Server side, so it costs nothing when unused.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: CALLOUT_REPLY_JSON_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") throw new Error("the model declined to answer");
  if (message.stop_reason === "max_tokens") throw new Error("the reply was cut off — try a shorter video");
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json;
}

async function openaiChat(
  baseUrl: string,
  config: ProviderConfig,
  prompt: string,
  jsonMode: boolean,
): Promise<string> {
  const json = (await postJson(
    `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    config.apiKey === "" ? {} : { authorization: `Bearer ${config.apiKey}` },
    {
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    },
  )) as { choices?: { message?: { content?: string | null } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text === "") throw new Error("the model returned no text");
  return text;
}

async function gemini(config: ProviderConfig, prompt: string): Promise<string> {
  const json = (await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
    { "x-goog-api-key": config.apiKey },
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    },
  )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (text === "") throw new Error("the model returned no text");
  return text;
}

export async function complete(config: ProviderConfig, prompt: string): Promise<string> {
  const info = PROVIDERS.find((p) => p.id === config.provider);
  if (info === undefined) throw new Error(`unknown provider "${config.provider}"`);
  if (info.needsKey && config.apiKey.trim() === "") throw new Error(`${info.label} needs an API key`);
  if (config.model.trim() === "") throw new Error("no model chosen");

  switch (config.provider) {
    case "anthropic":
      return anthropic(config, prompt);
    case "openai":
      return openaiChat("https://api.openai.com/v1", config, prompt, true);
    case "gemini":
      return gemini(config, prompt);
    case "openai-compatible":
      if (config.baseUrl.trim() === "") throw new Error("an OpenAI-compatible provider needs a base URL");
      // No JSON mode: servers disagree on whether they support it, and the
      // parser copes with prose around the JSON anyway.
      return openaiChat(config.baseUrl, config, prompt, false);
  }
}
