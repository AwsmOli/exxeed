/**
 * This week's official races, from iRacing's public season schedule.
 *
 * iRacing's Data API has the same schedule as clean JSON, but every endpoint in
 * it needs a signed-in member *and* an OAuth client iRacing issues on request —
 * a lot to ask for data iRacing publishes openly anyway. The public copy is a
 * PDF at a stable URL, refreshed whenever the schedule changes:
 * {@link SCHEDULE_PDF_URL}. No account, no key.
 *
 * ## The layout this reads
 *
 * One series per page (long ones run over several), in this order, all in the
 * left column:
 *
 *     Global Mazda MX-5 Cup by Fanatec - 2026 Season 4      ← title
 *     Global Mazda MX-5 Cup                                  ← cars, comma-separated,
 *                                                              wrapped across lines
 *     Rookie 1.0 --> Pro/WC 4.0                              ← licence: ends the cars
 *     Races every 30 minutes at :00 & :30                    ← details, ignored
 *     Week 1 (2026-09-15) | Okayama International Circuit - Full Course | …
 *
 * The week rows put the track in a second column; conditions and race length
 * are further right and ignored. A category heading ("D Class Series (SPORTS
 * CAR)") sits above the title where the category changes. The first pages are a
 * table of contents, recognisable by dot leaders.
 *
 * Positions are read as columns, not absolute coordinates, so a small layout
 * shift does not matter; a real format change fails the fixture test instead of
 * showing wrong tracks.
 */

export const SCHEDULE_PDF_URL = "https://members-assets.iracing.com/public/schedulepdf/SeasonSchedule.pdf";

export interface PdfCell {
  readonly x: number;
  readonly text: string;
}

/** One line of the page: its cells, left to right. */
export type PdfRow = readonly PdfCell[];

/** Everything left of this is the left column; the week rows' track column starts past it. */
const TRACK_COLUMN_X = 120;
/** And ends here, where the conditions column starts. */
const CONDITIONS_COLUMN_X = 330;

/** Text lines out of a PDF, grouped by baseline. */
export async function pdfRows(data: Uint8Array): Promise<PdfRow[]> {
  // The legacy build is the one that runs outside a browser.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;
  const rows: PdfRow[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      const lines = new Map<number, PdfCell[]>();
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        const y = Math.round(item.transform[5] as number);
        // Items on one visual line can differ by a point in baseline.
        const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        const line = lines.get(key) ?? [];
        line.push({ x: item.transform[4] as number, text: item.str.trim() });
        lines.set(key, line);
      }
      for (const y of [...lines.keys()].sort((a, b) => b - a)) {
        rows.push(lines.get(y)!.sort((a, b) => a.x - b.x));
      }
    }
  } finally {
    await task.destroy();
  }
  return rows;
}

export interface ScheduledWeek {
  /** As printed — 1-based, and past 12 for the year-long series. */
  readonly week: number;
  /** UTC date the week starts, "YYYY-MM-DD". */
  readonly startDate: string;
  readonly trackName: string;
  /** Empty for a track with one layout. */
  readonly configName: string;
}

export interface ScheduledSeries {
  /** The title as printed, e.g. "Global Mazda MX-5 Cup by Fanatec - 2026 Season 4". */
  readonly title: string;
  /** "Sports Car", "Oval", "Formula Car", … or "" if no heading preceded it. */
  readonly category: string;
  readonly cars: readonly string[];
  readonly weeks: readonly ScheduledWeek[];
}

const WEEK = /^Week (\d+) \((\d{4}-\d{2}-\d{2})\)$/;
const HEADING = /\(([^)]+)\)\s*$/;
const DOT_LEADER = /(\.\s){5,}/;

const titleCase = (value: string): string =>
  value.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Split "Track - Layout" at the first separator. iRacing's track names use a
 * bare hyphen (Spa-Francorchamps) and layouts may contain the spaced one
 * ("Oval - 2008"), so the first one is the boundary.
 */
export function splitTrack(value: string): { trackName: string; configName: string } {
  const at = value.indexOf(" - ");
  return at === -1
    ? { trackName: value.trim(), configName: "" }
    : { trackName: value.slice(0, at).trim(), configName: value.slice(at + 3).trim() };
}

export function parseSchedule(rows: readonly PdfRow[]): ScheduledSeries[] {
  const series: ScheduledSeries[] = [];
  let category = "";
  let header: string[] = [];
  let current: { title: string; category: string; cars: string[]; weeks: ScheduledWeek[] } | null = null;
  /** The week row still collecting a wrapped track name. */
  let open: { week: number; startDate: string; track: string[] } | null = null;

  const closeWeek = (): void => {
    if (open !== null && current !== null) {
      current.weeks.push({ week: open.week, startDate: open.startDate, ...splitTrack(open.track.join(" ")) });
    }
    open = null;
  };

  const startSeries = (): void => {
    // The header is title, cars…, licence. Anything before the licence line and
    // after the title is the car list, wrapped wherever the page ran out.
    const licence = header.findIndex((l) => l.includes("-->"));
    if (header.length === 0 || licence < 1) {
      header = [];
      return;
    }
    const cars = header
      .slice(1, licence)
      .join(" ")
      .split(/,\s*/)
      .map((c) => c.trim())
      .filter((c) => c !== "");
    current = { title: header[0]!, category, cars, weeks: [] };
    series.push(current);
    header = [];
  };

  for (const row of rows) {
    const left = row.filter((c) => c.x < TRACK_COLUMN_X);
    const track = row.filter((c) => c.x >= TRACK_COLUMN_X && c.x < CONDITIONS_COLUMN_X);
    const leftText = left.map((c) => c.text).join(" ").trim();

    // Table of contents. Whatever was collected before it (the cover title) is
    // not a series header.
    if (DOT_LEADER.test(row.map((c) => c.text).join(" "))) {
      header = [];
      continue;
    }

    const week = WEEK.exec(leftText);
    if (week !== null) {
      closeWeek();
      if (header.length > 0) startSeries();
      open = { week: Number(week[1]), startDate: week[2]!, track: track.map((c) => c.text) };
      continue;
    }

    if (leftText === "") {
      // A track-column line on its own: either the race date "(2026-09-19 12:00 1x)",
      // which ends the track name, or the track name wrapping.
      const text = track.map((c) => c.text).join(" ");
      if (open !== null && text !== "") {
        if (text.startsWith("(")) closeWeek();
        else open.track.push(text);
      }
      continue;
    }

    // Left-column text that is not a week row: a heading, a page number, or a
    // header line of the next series.
    closeWeek();
    if (/^\d+$/.test(leftText)) continue;
    // "D Class Series (SPORTS CAR)". The capitals are what tell it from a
    // series whose own title ends in brackets.
    const heading = HEADING.exec(leftText);
    if (heading !== null && /Series \(/.test(leftText) && heading[1] === heading[1]!.toUpperCase()) {
      category = titleCase(heading[1]!);
      header = [];
      continue;
    }
    header.push(leftText);
  }
  closeWeek();

  return series.filter((s) => s.weeks.length > 0);
}

export interface RaceWeekEntry {
  readonly seriesName: string;
  readonly category: string;
  readonly week: number;
  readonly startDate: string;
  readonly trackName: string;
  readonly configName: string;
  readonly cars: readonly string[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What each series is racing at `now`: the latest week that has started,
 * provided the series has not finished. By date rather than week number, so the
 * year-long series (37 weeks from February) and week 13 need no special case.
 */
export function raceWeekAt(schedule: readonly ScheduledSeries[], now: Date): RaceWeekEntry[] {
  const t = now.getTime();
  const entries: RaceWeekEntry[] = [];
  for (const s of schedule) {
    const started = s.weeks.filter((w) => Date.parse(`${w.startDate}T00:00:00Z`) <= t);
    const week = started.at(-1);
    if (week === undefined) continue;
    if (t >= Date.parse(`${week.startDate}T00:00:00Z`) + WEEK_MS && week === s.weeks.at(-1)) continue;
    entries.push({
      seriesName: s.title,
      category: s.category,
      week: week.week,
      startDate: week.startDate,
      trackName: week.trackName,
      configName: week.configName,
      cars: s.cars,
    });
  }
  return entries.sort((a, b) => a.seriesName.localeCompare(b.seriesName));
}

/** Fetch and parse the public schedule. */
export async function fetchSchedule(): Promise<{ series: ScheduledSeries[]; lastModified: string | null }> {
  const response = await fetch(SCHEDULE_PDF_URL);
  if (!response.ok) throw new Error(`iRacing's schedule PDF — HTTP ${response.status}`);
  const rows = await pdfRows(new Uint8Array(await response.arrayBuffer()));
  const series = parseSchedule(rows);
  if (series.length === 0) throw new Error("iRacing's schedule PDF did not contain any series this parser recognises");
  return { series, lastModified: response.headers.get("last-modified") };
}
