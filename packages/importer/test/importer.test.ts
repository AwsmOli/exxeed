import { describe, expect, it } from "vitest";

import {
  buildCalloutPrompt,
  chooseCaptions,
  extractJson,
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
  it("lists the map's turns as the only valid ones", () => {
    const prompt = buildCalloutPrompt({
      trackName: "Daytona International Speedway",
      configName: "Road Course",
      carName: "Mazda MX-5 Cup",
      corners: [{ turn: 1, names: ["International Horseshoe"], direction: "left", severity: 5 }],
      video: { title: "Daytona guide", channel: "Coach" },
      transcript: [{ startMs: 5000, text: "brake at the two board" }],
    });
    expect(prompt).toContain('Turn 1 "International Horseshoe": left, severity 5/6');
    expect(prompt).toContain("ONLY valid turn numbers");
    expect(prompt).toContain("[0:05] brake at the two board");
  });

  it("falls back to conventional numbering without a map", () => {
    const prompt = buildCalloutPrompt({
      trackName: "Spa",
      configName: "",
      carName: "GT3",
      corners: null,
      video: { title: "t", channel: "c" },
      transcript: [],
    });
    expect(prompt).toContain("conventionally");
  });
});

describe("parsing a reply", () => {
  const chatReply = [
    "Sure! Here are the callouts:",
    "```json",
    JSON.stringify({
      callouts: [
        { turn: 3, throughTurn: null, text: "Kink, flat.", textShort: "Flat", confidence: 0.9, sourceTs: "1:10" },
        { turn: 1, throughTurn: 2, text: "Brake at the 100 board, third.", textShort: "100, third", confidence: 0.8, sourceTs: "0:40" },
        { turn: 9, text: "Not a real turn.", textShort: "x", confidence: 0.5, sourceTs: null },
        { turn: "one", text: "" },
      ],
    }),
    "```",
    "Let me know if you want changes.",
  ].join("\n");

  it("finds the JSON in prose and fences", () => {
    expect(extractJson('blah {"callouts": []} blah')).toEqual({ callouts: [] });
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
  });

  it("keeps valid turns, sorts them, and says what it dropped", () => {
    const parsed = parseCalloutReply(chatReply, [1, 2, 3]);
    expect(parsed.callouts.map((c) => c.turn)).toEqual([1, 3]);
    expect(parsed.callouts[0]).toMatchObject({ throughTurn: 2, sourceMs: 40_000 });
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.problems.join(" ")).toMatch(/turn 9/);
  });

  it("trusts any turn when there is no map", () => {
    expect(parseCalloutReply(chatReply, null).callouts.map((c) => c.turn)).toEqual([1, 3, 9]);
  });

  it("flags two callouts on the same turn", () => {
    const reply = JSON.stringify({
      callouts: [
        { turn: 1, text: "a", textShort: "a" },
        { turn: 1, text: "b", textShort: "b" },
      ],
    });
    expect(parseCalloutReply(reply, null).problems.join(" ")).toMatch(/turn 1 has 2 callouts/);
  });

  it("produces a profile the core importer accepts", () => {
    const { callouts } = parseCalloutReply(chatReply, [1, 2, 3]);
    const profile = toImportProfile(callouts, { videoId: "abcdefghijk", title: "T", channel: "C" }, "mx5");
    expect(profile.source.url).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(profile.callouts[0]).toMatchObject({ turn: 1, throughTurn: 2, sourceTs: "0:40", priority: 1 });
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
