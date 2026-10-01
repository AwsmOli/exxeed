import { describe, expect, it } from "vitest";

import { carIdFromPath, readLapFileHeader } from "@exxeed/core";

/** A synthetic lap file with the header fields where real ones have them. */
function lapFile(magic = "BLAP"): Uint8Array {
  const bytes = new Uint8Array(0x700);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  put(0, magic);
  view.setInt32(0x04, 3, true);
  view.setInt32(0x0c, 290574, true);
  put(0x10, "Sebastian Crex");
  put(0x90, "mx5\\mx52016");
  put(0x53e, "tsukuba\\2kfull");
  view.setFloat32(0x5b4, 62.667, true);
  return bytes;
}

describe("readLapFileHeader", () => {
  it("reads driver, car, track and lap time from a best-lap file", () => {
    const header = readLapFileHeader(lapFile());
    expect(header).toMatchObject({
      magic: "BLAP",
      formatVersion: 3,
      custId: 290574,
      driver: "Sebastian Crex",
      carPath: "mx5\\mx52016",
      trackPath: "tsukuba\\2kfull",
    });
    expect(header?.lapTimeS).toBeCloseTo(62.667, 3);
  });

  it("decodes a driver name as UTF-8", () => {
    const bytes = lapFile();
    const name = new TextEncoder().encode("Lawrence Rojas Gutiérrez");
    bytes.fill(0, 0x10, 0x50);
    bytes.set(name, 0x10);
    expect(readLapFileHeader(bytes)?.driver).toBe("Lawrence Rojas Gutiérrez");
  });

  it("reads an optimal-lap file the same way", () => {
    expect(readLapFileHeader(lapFile("OLAP"))?.magic).toBe("OLAP");
  });

  it("returns null for something that is not a lap file", () => {
    expect(readLapFileHeader(new Uint8Array(0x700))).toBeNull();
    expect(readLapFileHeader(new Uint8Array(10))).toBeNull();
  });

  it("turns the car path into the app's car id", () => {
    expect(carIdFromPath("mx5\\mx52016")).toBe("mx5-mx52016");
  });
});
