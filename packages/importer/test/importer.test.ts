import { describe, expect, it } from "vitest";

import {
  buildCalloutPrompt,
  chooseCaptions,
  extractJson,
  learnTurnNumbers,
  formatTimestamp,
  mergeLines,
  parseCalloutReply,
  parseJson3,
  parseTimestamp,
  parseVtt,
  toImportProfile,
} from "@exxeed/importer";

describe("transcripts", () => {
  it("reads json3 and drops the empty append events", () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "[Music]" }] },
        { tStartMs: 1200, segs: [{ utf8: "brake at" }, { utf8: " the hundred" }] },
        { tStartMs: 2400, aAppend: 1, segs: [{ utf8: "\n" }] },
        { tStartMs: 3000, segs: [{ utf8: "board." }] },
      ],
    });
    expect(parseJson3(raw)).toEqual([
      { startMs: 1200, text: "brake at the hundred" },
      { startMs: 3000, text: "board." },
    ]);
  });

  it("de-duplicates rolling auto-caption VTT", () => {
    const raw = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "turn one<00:00:01.500><c> brake</c>",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "turn one brake",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "turn one brake at the marker",
    ].join("\n");
    expect(parseVtt(raw)).toEqual([
      { startMs: 1000, text: "turn one brake" },
      { startMs: 3000, text: "at the marker" },
    ]);
  });

  it("merges fragments up to a sentence", () => {
    const merged = mergeLines([
      { startMs: 0, text: "into turn one" },
      { startMs: 2000, text: "brake at the board." },
      { startMs: 4000, text: "then third" },
      { startMs: 30_000, text: "turn two" },
    ]);
    expect(merged.map((l) => l.text)).toEqual([
      "into turn one brake at the board.",
      "then third",
      "turn two",
    ]);
  });

  it("round-trips timestamps", () => {
    expect(formatTimestamp(134_000)).toBe("2:14");
    expect(formatTimestamp(3_725_000)).toBe("1:02:05");
    expect(parseTimestamp("2:14")).toBe(134_000);
    expect(parseTimestamp("1:02:05")).toBe(3_725_000);
    expect(parseTimestamp("soon")).toBeNull();
  });
});

describe("the prompt", () => {
  const corner = {
    id: 1,
    names: ["International Horseshoe"],
    direction: "left" as const,
    severity: 5,
    entryM: 348,
    officialTurn: null,
    brakeBeforeM: 57,
    minSpeedKph: 87,
    gear: 2,
  };
  const base = {
    trackName: "Daytona International Speedway",
    configName: "Road Course",
    lengthM: 5687,
    carName: "Mazda MX-5 Cup",
    video: { title: "Daytona guide", channel: "Coach" },
    transcript: [{ startMs: 5000, text: "brake at the two board" }],
  };

  it("describes each corner the way a driver meets it", () => {
    const prompt = buildCalloutPrompt({ ...base, corners: [corner] });
    expect(prompt).toContain(
      'Corner 1 "International Horseshoe": 348 m from the start line (6% of the lap), left-hander, slow, ' +
        "reference lap brakes ~57 m before turn-in, slowest ~87 km/h, gear 2",
    );
    expect(prompt).toContain("[0:05] brake at the two board");
  });

  it("warns that our numbers are not the official ones until they are learned", () => {
    expect(buildCalloutPrompt({ ...base, corners: [corner] })).toContain("may NOT match");
    const learned = buildCalloutPrompt({ ...base, corners: [{ ...corner, officialTurn: 1 }] });
    expect(learned).not.toContain("may NOT match");
    expect(learned).toContain("Corner 1 (official Turn 1)");
  });

  it("falls back to official numbering without a map", () => {
    const prompt = buildCalloutPrompt({ ...base, corners: null });
    expect(prompt).toContain("official turn");
  });
});

describe("parsing a reply", () => {
  const chatReply = [
    "Sure! Here are the callouts:",
    "```json",
    JSON.stringify({
      layoutMatches: true,
      layoutNote: null,
      callouts: [
        { corner: 3, throughCorner: null, coachTurn: 4, text: "Kink, flat.", textShort: "Flat", confidence: 0.9, sourceTs: "1:10" },
        { corner: 1, throughCorner: 2, coachTurn: 1, text: "Brake at the 100 board, third.", textShort: "100, third", confidence: 0.8, sourceTs: "0:40" },
        { corner: 9, coachTurn: null, text: "Not a real corner.", textShort: "x", confidence: 0.5, sourceTs: null },
        { corner: "one", text: "" },
      ],
    }),
    "```",
    "Let me know if you want changes.",
  ].join(String.fromCharCode(10));

  it("finds the JSON in prose and fences", () => {
    expect(extractJson('blah {"callouts": []} blah')).toEqual({ callouts: [] });
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
  });

  it("keeps valid corners, sorts them, and says what it dropped", () => {
    const parsed = parseCalloutReply(chatReply, [1, 2, 3]);
    expect(parsed.callouts.map((c) => c.turn)).toEqual([1, 3]);
    expect(parsed.callouts[0]).toMatchObject({ throughTurn: 2, coachTurn: 1, sourceMs: 40_000 });
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems.join(" ")).toMatch(/corner 9/);
    expect(parsed.layoutWarning).toBeNull();
  });

  it("still reads a reply to the old prompt, which said turn", () => {
    const old = JSON.stringify({ callouts: [{ turn: 2, throughTurn: 3, text: "a", textShort: "a" }] });
    expect(parseCalloutReply(old, null).callouts[0]).toMatchObject({ turn: 2, throughTurn: 3, coachTurn: null });
  });

  it("passes on a layout the model says does not match", () => {
    const reply = JSON.stringify({ layoutMatches: false, layoutNote: "this guide is for the 200 layout", callouts: [] });
    expect(parseCalloutReply(reply, null).layoutWarning).toBe("this guide is for the 200 layout");
  });

  it("trusts any corner when there is no map", () => {
    expect(parseCalloutReply(chatReply, null).callouts.map((c) => c.turn)).toEqual([1, 3, 9]);
  });

  it("flags two callouts on the same corner", () => {
    const reply = JSON.stringify({
      callouts: [
        { corner: 1, text: "a", textShort: "a" },
        { corner: 1, text: "b", textShort: "b" },
      ],
    });
    expect(parseCalloutReply(reply, null).problems.join(" ")).toMatch(/corner 1 has 2 callouts/);
  });

  it("produces a profile the core importer accepts", () => {
    const { callouts } = parseCalloutReply(chatReply, [1, 2, 3]);
    const profile = toImportProfile(callouts, { videoId: "abcdefghijk", title: "T", channel: "C" }, "mx5");
    expect(profile.source.url).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(profile.callouts[0]).toMatchObject({ turn: 1, throughTurn: 2, sourceTs: "0:40", priority: 1 });
  });
});

describe("learnTurnNumbers", () => {
  const draft = (turn: number, coachTurn: number | null) => ({
    turn, throughTurn: null, coachTurn, text: "t", textShort: "t", confidence: null, sourceMs: null,
  });

  it("learns what the coach said, including an offset from our numbering", () => {
    // Our corner 2 is a kink the coach does not count, so our 3 is their turn 2.
    const learned = learnTurnNumbers([draft(1, 1), draft(3, 2), draft(4, 3), draft(5, null)], {});
    expect(learned.turns).toEqual({ "1": 1, "3": 2, "4": 3 });
    expect(learned.added).toBe(3);
    expect(learned.conflicts).toEqual([]);
  });

  it("keeps what it knew and reports a guide that disagrees", () => {
    const learned = learnTurnNumbers([draft(3, 5), draft(6, 6)], { "3": 2 });
    expect(learned.turns).toEqual({ "3": 2, "6": 6 });
    expect(learned.conflicts.join(" ")).toMatch(/known as turn 2/);
  });

  it("refuses numbers that are out of lap order or claimed twice", () => {
    const learned = learnTurnNumbers([draft(2, 5), draft(4, 3)], { "1": 1, "6": 4 });
    expect(learned.turns).toEqual({ "1": 1, "6": 4, "4": 3 });
    expect(learned.conflicts.join(" ")).toMatch(/out of lap order/);
    expect(learnTurnNumbers([draft(2, 3), draft(4, 3)], {}).conflicts.join(" ")).toMatch(/already corner 2/);
  });
});

describe("chooseCaptions", () => {
  const f = (ext: string) => ({ ext, url: `https://x/${ext}` });

  it("prefers the uploader's English, in json3", () => {
    expect(chooseCaptions({ "en-GB": [f("vtt"), f("json3")], de: [f("json3")] }, { "en-orig": [f("json3")] })).toEqual({
      kind: "manual",
      language: "en-GB",
      ext: "json3",
      url: "https://x/json3",
    });
  });

  it("falls back to the untranslated automatic track", () => {
    expect(chooseCaptions({ de: [f("json3")] }, { en: [f("json3")], "en-orig": [f("vtt")] })).toMatchObject({
      kind: "auto",
      language: "en-orig",
      ext: "vtt",
    });
  });

  it("returns null when there is nothing English", () => {
    expect(chooseCaptions({}, { fr: [f("json3")] })).toBeNull();
  });
});
