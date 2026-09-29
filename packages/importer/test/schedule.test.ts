import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseSchedule, raceWeekAt, splitTrack, type PdfRow } from "@exxeed/importer";

/**
 * Pages 1, 29–31, 66 and 67 of iRacing's public schedule PDF as of
 * 2026-09-29, as `pdfRows` saw them: one line per row, `x:text` per cell. Text
 * rather than the PDF itself, so a layout change shows up as a readable diff.
 */
const fixture = (): PdfRow[] =>
  readFileSync(new URL("./fixtures/season-schedule-2026s4.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("=== page"))
    .map((line) =>
      line.split(" | ").map((cell) => {
        const at = cell.indexOf(":");
        return { x: Number(cell.slice(0, at)), text: cell.slice(at + 1) };
      }),
    );

describe("parseSchedule", () => {
  const schedule = parseSchedule(fixture());
  const byTitle = (prefix: string) => schedule.find((s) => s.title.startsWith(prefix));

  it("skips the table of contents and finds each series", () => {
    expect(schedule.map((s) => s.title)).toEqual([
      "NASCAR iRacing Series - 2026 Season Fixed",
      "Global Mazda MX-5 Cup by Fanatec - 2026 Season 4",
      "BMW M Power Challenge - 2026 Season 4",
    ]);
  });

  it("reads a single-car series and its twelve weeks", () => {
    const mx5 = byTitle("Global Mazda MX-5 Cup")!;
    expect(mx5.cars).toEqual(["Global Mazda MX-5 Cup"]);
    expect(mx5.weeks).toHaveLength(12);
    expect(mx5.weeks[2]).toEqual({
      week: 3,
      startDate: "2026-09-29",
      trackName: "Tsukuba Circuit",
      configName: "2000 Full",
    });
    expect(mx5.weeks[9]).toMatchObject({ trackName: "Circuit de Lédenon", configName: "" });
  });

  it("joins a car list that wraps mid-name", () => {
    expect(byTitle("NASCAR iRacing Series")!.cars).toEqual([
      "NASCAR Cup Series Next Gen Chevrolet Camaro ZL1",
      "NASCAR Cup Series Next Gen Ford Mustang",
      "NASCAR Cup Series Next Gen Toyota Camry",
    ]);
  });

  it("carries a series across pages, and takes the category from its heading", () => {
    const nascar = byTitle("NASCAR iRacing Series")!;
    // Pages 30 and 31: the second starts with week rows and no title.
    expect(nascar.weeks.map((w) => w.week)).toContain(10);
    expect(byTitle("BMW M Power")!.category).toBe("Sports Car");
  });
});

describe("splitTrack", () => {
  it("splits at the first spaced hyphen only", () => {
    expect(splitTrack("Circuit de Spa-Francorchamps - Grand Prix Pits")).toEqual({
      trackName: "Circuit de Spa-Francorchamps",
      configName: "Grand Prix Pits",
    });
    expect(splitTrack("Daytona International Speedway - Oval - 2008")).toEqual({
      trackName: "Daytona International Speedway",
      configName: "Oval - 2008",
    });
  });
});

describe("raceWeekAt", () => {
  const schedule = parseSchedule(fixture());

  it("picks the week that has started, by date", () => {
    const mx5 = raceWeekAt(schedule, new Date("2026-10-01T12:00:00Z")).find((e) =>
      e.seriesName.startsWith("Global Mazda"),
    );
    expect(mx5).toMatchObject({ week: 3, trackName: "Tsukuba Circuit" });
  });

  it("rolls over at 00:00 UTC on the week's start date", () => {
    const at = (iso: string) =>
      raceWeekAt(schedule, new Date(iso)).find((e) => e.seriesName.startsWith("Global Mazda"))?.week;
    expect(at("2026-10-05T23:59:59Z")).toBe(3);
    expect(at("2026-10-06T00:00:00Z")).toBe(4);
  });

  it("drops a series before it starts and after its last week", () => {
    const titles = (iso: string) => raceWeekAt(schedule, new Date(iso)).map((e) => e.seriesName);
    expect(titles("2026-09-01T00:00:00Z")).not.toContain("Global Mazda MX-5 Cup by Fanatec - 2026 Season 4");
    expect(titles("2026-12-20T00:00:00Z")).not.toContain("Global Mazda MX-5 Cup by Fanatec - 2026 Season 4");
  });
});
