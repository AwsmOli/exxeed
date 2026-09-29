/**
 * YouTube, through yt-dlp — search and captions both.
 *
 * Neither goes through the Data API. Search there costs 100 quota units a call
 * and needs a key; captions for a video you do not own are not available through
 * it at all (TODO.md, M5). yt-dlp does both with no key, which is also why this
 * is an authoring tool rather than something the runtime ever touches: it
 * scrapes, and what it does is a property of the person running it.
 *
 * The binary is found on PATH first, then in the app's own tools folder, and can
 * be fetched there from yt-dlp's GitHub releases — the same shape as Piper
 * (packages/tts/src/voices.ts).
 */

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { mergeLines, parseJson3, parseVtt, type TranscriptLine } from "./transcript.js";

const BINARY = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

const RELEASE_ASSET: Partial<Record<NodeJS.Platform, string>> = {
  win32: "yt-dlp.exe",
  darwin: "yt-dlp_macos",
  linux: "yt-dlp_linux",
};

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Where yt-dlp is, or null. PATH wins, so a system install stays in charge of its own updates. */
export async function resolveYtDlp(toolsDir: string): Promise<string | null> {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, BINARY);
    if (await isFile(candidate)) return candidate;
  }
  const bundled = join(toolsDir, BINARY);
  return (await isFile(bundled)) ? bundled : null;
}

export async function installYtDlp(
  toolsDir: string,
  onProgress?: (received: number, total: number) => void,
): Promise<string> {
  const asset = RELEASE_ASSET[process.platform];
  if (asset === undefined) throw new Error(`no yt-dlp build for ${process.platform} — install it yourself`);

  await mkdir(toolsDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`${url} — HTTP ${response.status}`);

  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });

  const target = join(toolsDir, BINARY);
  const partial = `${target}.partial`;
  await pipeline(body, createWriteStream(partial));
  await rename(partial, target);
  if (process.platform !== "win32") await chmod(target, 0o755);
  return target;
}

/**
 * yt-dlp, and the JavaScript runtime it solves YouTube's player challenges with.
 *
 * Without a runtime, current yt-dlp falls back to a client that YouTube serves
 * a reduced page — and on that page every video "has no captions", which is
 * indistinguishable from a video that genuinely has none. Node on PATH is used
 * when there is one; otherwise the Electron binary running this code is a Node
 * too, with ELECTRON_RUN_AS_NODE set for the child.
 */
export interface YtDlp {
  readonly binary: string;
  readonly runtime: { readonly path: string; readonly env: Readonly<Record<string, string>> } | null;
}

async function onPath(name: string): Promise<string | null> {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir !== "" && (await isFile(join(dir, exe)))) return join(dir, exe);
  }
  return null;
}

export async function resolveYtDlpSetup(toolsDir: string): Promise<YtDlp | null> {
  const binary = await resolveYtDlp(toolsDir);
  if (binary === null) return null;
  const node = await onPath("node");
  if (node !== null) return { binary, runtime: { path: node, env: {} } };
  if (process.versions["electron"] !== undefined) {
    return { binary, runtime: { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } } };
  }
  return { binary, runtime: null };
}

const run = (yt: YtDlp, args: readonly string[], timeoutMs = 90_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const runtimeArgs = yt.runtime === null ? [] : ["--js-runtimes", `node:${yt.runtime.path}`];
    execFile(
      yt.binary,
      [...runtimeArgs, ...args],
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, ...(yt.runtime?.env ?? {}) },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          // yt-dlp's last ERROR line is the useful one; the rest is warnings
          // about things that did not stop it.
          const last = stderr.trim().split("\n").filter((l) => l.includes("ERROR")).pop();
          reject(new Error(last?.replace(/^ERROR:\s*/, "") ?? error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface VideoResult {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  readonly durationS: number | null;
  readonly views: number | null;
  readonly thumbnail: string;
}

interface FlatEntry {
  readonly id?: string;
  readonly title?: string;
  readonly channel?: string | null;
  readonly uploader?: string | null;
  readonly duration?: number | null;
  readonly view_count?: number | null;
}

/** Search YouTube. `--flat-playlist` keeps it to one request, no per-video page loads. */
export async function searchVideos(yt: YtDlp, query: string, count = 15): Promise<VideoResult[]> {
  const out = await run(yt, ["--flat-playlist", "--dump-single-json", "--no-warnings", `ytsearch${count}:${query}`]);
  const data = JSON.parse(out) as { entries?: readonly FlatEntry[] };
  return (data.entries ?? [])
    .filter((e): e is FlatEntry & { id: string } => typeof e.id === "string")
    .map((e) => ({
      id: e.id,
      title: e.title ?? e.id,
      channel: e.channel ?? e.uploader ?? "",
      durationS: e.duration ?? null,
      views: e.view_count ?? null,
      // Built rather than read: flat entries carry a list of thumbnails of
      // varying shapes, and this URL is stable for every public video.
      thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    }));
}

export interface Transcript {
  readonly lines: readonly TranscriptLine[];
  /** Human captions are better than auto ones, and a reviewer should know which this is. */
  readonly kind: "manual" | "auto";
  readonly language: string;
}

type Tracks = Readonly<Record<string, readonly { readonly ext: string; readonly url: string }[]>>;

export interface CaptionChoice {
  readonly kind: "manual" | "auto";
  readonly language: string;
  readonly ext: "json3" | "vtt";
  readonly url: string;
}

/**
 * Which caption track to read: the uploader's English if there is any, then
 * YouTube's automatic track in the spoken language (`en-orig`), then its plain
 * `en` — never a machine translation from another language.
 */
export function chooseCaptions(subtitles: Tracks, automatic: Tracks): CaptionChoice | null {
  const pick = (tracks: Tracks, langs: readonly string[], kind: "manual" | "auto"): CaptionChoice | null => {
    for (const language of langs) {
      const formats = tracks[language] ?? [];
      for (const ext of ["json3", "vtt"] as const) {
        const format = formats.find((f) => f.ext === ext);
        if (format !== undefined) return { kind, language, ext, url: format.url };
      }
    }
    return null;
  };
  const manualLangs = Object.keys(subtitles)
    .filter((l) => l === "en" || l.startsWith("en-"))
    .sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)));
  return pick(subtitles, manualLangs, "manual") ?? pick(automatic, ["en-orig", "en"], "auto");
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const RATE_LIMITED =
  "YouTube is rate-limiting caption requests from this connection. Wait a few minutes and try again.";

/**
 * The English captions for a video.
 *
 * Two requests: yt-dlp reads the video's page once for its caption tracks, and
 * the chosen track is fetched directly. Letting yt-dlp download the captions
 * itself fetched every matching track, and caption downloads are what YouTube
 * rate-limits first — a few guides in a row was enough to get HTTP 429.
 */
export async function fetchTranscript(yt: YtDlp, videoId: string): Promise<Transcript> {
  if (!VIDEO_ID.test(videoId)) throw new Error(`"${videoId}" is not a YouTube video id`);

  let info: { subtitles?: Tracks; automatic_captions?: Tracks };
  try {
    info = JSON.parse(
      await run(yt, ["--dump-json", "--skip-download", "--no-warnings", `https://www.youtube.com/watch?v=${videoId}`]),
    ) as typeof info;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(/429|reloaded|not a bot/i.test(message) ? RATE_LIMITED : message);
  }

  const choice = chooseCaptions(info.subtitles ?? {}, info.automatic_captions ?? {});
  if (choice === null) {
    throw new Error(
      "YouTube lists no English captions for this video. If every video says this, " +
        "YouTube is limiting this connection — try again in a few minutes.",
    );
  }

  const response = await fetch(choice.url);
  if (response.status === 429) throw new Error(RATE_LIMITED);
  if (!response.ok) throw new Error(`captions download failed — HTTP ${response.status}`);
  const raw = await response.text();

  const lines = mergeLines(choice.ext === "json3" ? parseJson3(raw) : parseVtt(raw));
  if (lines.length === 0) throw new Error("the captions are empty");
  return { lines, kind: choice.kind, language: choice.language };
}
