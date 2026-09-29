/**
 * A video's captions, as timed lines a person can read and a model can cite.
 *
 * yt-dlp hands back one of two shapes. `json3` is YouTube's own caption format
 * and the one asked for first: one event per caption, already free of the
 * rolling duplicates auto-captions are notorious for. WebVTT is the fallback,
 * and for auto-captions it repeats every line two or three times as it scrolls,
 * so it is de-duplicated here rather than handed on.
 *
 * Either way the output is the same: short lines with a start time, merged up to
 * roughly a sentence. The start time matters more than it looks — it is what
 * becomes `sourceTs` on a callout, which is how the review step (§10 stage 5)
 * gets from a note back to the moment in the video the coach said it.
 */

export interface TranscriptLine {
  readonly startMs: number;
  readonly text: string;
}

const clean = (text: string): string =>
  text
    .replace(/\[(music|applause|laughter)\]/gi, "")
    // Auto-captions bleep what they take for swearing as "[ __ ]" — which in a
    // sim-racing video is as often as not "iRacing" misheard.
    .replace(/\[\s*_+\s*\]/g, "")
    .replace(/\s+/g, " ")
    // …and put a space before every punctuation mark they insert.
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();

interface Json3 {
  readonly events?: readonly {
    readonly tStartMs?: number;
    readonly segs?: readonly { readonly utf8?: string }[];
  }[];
}

export function parseJson3(raw: string): TranscriptLine[] {
  const data = JSON.parse(raw) as Json3;
  const lines: TranscriptLine[] = [];
  for (const event of data.events ?? []) {
    if (event.segs === undefined) continue;
    const text = clean(event.segs.map((s) => s.utf8 ?? "").join(""));
    if (text === "") continue;
    lines.push({ startMs: event.tStartMs ?? 0, text });
  }
  return lines;
}

const vttTime = (value: string): number | null => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  if (m === null) return null;
  const [, h, min, s, ms] = m;
  return ((Number(h ?? 0) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms);
};

export function parseVtt(raw: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let previous = "";
  for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const timing = rows.findIndex((r) => r.includes("-->"));
    if (timing === -1) continue;
    const startMs = vttTime(rows[timing]!.split("-->")[0]!);
    if (startMs === null) continue;

    // Auto-captions carry per-word timing tags; strip them, and any styling.
    const texts = rows
      .slice(timing + 1)
      .map((r) => clean(r.replace(/<[^>]+>/g, "")))
      .filter((r) => r !== "");

    // A rolling caption repeats the line before it and adds to it. Keep only
    // what is new.
    for (const text of texts) {
      if (text === previous) continue;
      const fresh = text.startsWith(previous) && previous !== "" ? text.slice(previous.length).trim() : text;
      previous = text;
      if (fresh !== "") lines.push({ startMs, text: fresh });
    }
  }
  return lines;
}

/**
 * Merge caption fragments into sentence-sized lines.
 *
 * Auto-captions arrive two to five words at a time. That is unreadable in a
 * list and wasteful in a prompt — every fragment pays for its own timestamp —
 * so fragments join until a sentence ends or the line has run for `maxMs`.
 */
export function mergeLines(lines: readonly TranscriptLine[], maxMs = 12_000): TranscriptLine[] {
  const merged: TranscriptLine[] = [];
  let current: { startMs: number; parts: string[] } | null = null;

  const flush = (): void => {
    if (current !== null) merged.push({ startMs: current.startMs, text: current.parts.join(" ") });
    current = null;
  };

  for (const line of lines) {
    if (current !== null && line.startMs - current.startMs > maxMs) flush();
    if (current === null) current = { startMs: line.startMs, parts: [] };
    current.parts.push(line.text);
    if (/[.!?]$/.test(line.text)) flush();
  }
  flush();
  return merged;
}

/** "mm:ss", or "h:mm:ss" past the hour — the form a person types into a player. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Back from "m:ss" or "h:mm:ss" to milliseconds, or null for anything else. */
export function parseTimestamp(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0) * 1000;
}

export function transcriptText(lines: readonly TranscriptLine[]): string {
  return lines.map((l) => `[${formatTimestamp(l.startMs)}] ${l.text}`).join("\n");
}
