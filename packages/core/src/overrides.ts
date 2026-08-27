/**
 * Hand corrections to detected corners — SPEC.md §5.2.
 *
 * "Do not try to solve these algorithmically. Ship a per-track
 * corners.override.json that can merge, split, rename or insert corners by hand,
 * applied after detection. Ten minutes per track beats a week of tuning."
 *
 * This file is that mechanism, and it is worth being clear that it is the design
 * rather than an admission of defeat. Daytona makes the case concretely: two of
 * its corrections are both "detection got the sign wrong across a region", and
 * they need **opposite** fixes —
 *
 *   - T6's entry is a 0.153 rad left flick under braking, immediately before a
 *     1.03 rad right. It must MERGE into the right-hander.
 *   - T9/T10 is a 0.471 rad left immediately before a 0.677 rad right. It must
 *     SPLIT at the sign change.
 *
 * Structurally identical, opposite answers, and only magnitude separates them.
 * Any rule that fixes one breaks the other, which is exactly why §5.2 says spend
 * the ten minutes.
 *
 * Every operation addresses corners by their **detected** index, all resolved
 * against the original detection rather than against each other's output. That
 * keeps a file order-independent and stable: adding a merge at the top does not
 * silently renumber every operation below it.
 */

import { z } from "zod";

import type { DetectedCorner } from "./corners.js";
import { severityOf } from "./corners.js";
import { wrapPct } from "./pct.js";
import type { Corner } from "./schema.js";

const PctValue = z.number().min(0).lt(1);

export const CornerOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("merge"),
    /** Detected indices to fuse into one corner, in track order. */
    indices: z.array(z.number().int().positive()).min(2),
    names: z.array(z.string()).optional(),
    why: z.string().optional(),
  }),
  z.object({
    op: z.literal("split"),
    index: z.number().int().positive(),
    /** Split points, as lap positions inside the detected region. */
    atPct: z.array(PctValue).min(1),
    names: z.array(z.array(z.string())).optional(),
    why: z.string().optional(),
  }),
  z.object({
    op: z.literal("drop"),
    index: z.number().int().positive(),
    why: z.string().optional(),
  }),
  z.object({
    op: z.literal("rename"),
    index: z.number().int().positive(),
    names: z.array(z.string()),
    why: z.string().optional(),
  }),
  z.object({
    op: z.literal("insert"),
    entryPct: PctValue,
    apexPct: PctValue,
    exitPct: PctValue,
    direction: z.enum(["left", "right"]),
    severity: z.number().int().min(1).max(6),
    names: z.array(z.string()).optional(),
    why: z.string().optional(),
  }),
]);

export const CornerOverridesSchema = z.object({
  schema: z.literal(1),
  /** Free text: which lap this was cut against, who checked it, anything useful. */
  note: z.string().optional(),
  operations: z.array(CornerOperationSchema).default([]),
});

export type CornerOperation = z.infer<typeof CornerOperationSchema>;
export type CornerOverrides = z.infer<typeof CornerOverridesSchema>;

export class CornerOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CornerOverrideError";
  }
}

/** Working shape while operations are applied — index is still the detected one. */
interface Piece {
  entryPct: number;
  apexPct: number;
  exitPct: number;
  direction: "left" | "right";
  severity: number;
  names: string[];
  /** Where this piece starts, unwrapped, purely so the result can be ordered. */
  sortKey: number;
}

const pieceOf = (c: DetectedCorner): Piece => ({
  entryPct: c.entryPct,
  apexPct: c.apexPct,
  exitPct: c.exitPct,
  direction: c.direction,
  severity: c.severity,
  names: [],
  sortKey: c.entryPct,
});

/**
 * Apply a set of hand corrections to a detected corner list.
 *
 * Returns corners renumbered 1..n in track order, which is what §5 step 5 asks
 * for and what every `cornerIndex` downstream refers to.
 */
export function applyOverrides(
  detected: readonly DetectedCorner[],
  overrides: CornerOverrides,
  lap?: { readonly gridSize: number; readonly speedMps: readonly number[]; readonly steerRad: readonly number[] },
): Corner[] {
  const byIndex = new Map<number, DetectedCorner>();
  for (const c of detected) byIndex.set(c.index, c);

  const require = (index: number, op: string): DetectedCorner => {
    const c = byIndex.get(index);
    if (c === undefined) {
      throw new CornerOverrideError(
        `${op} refers to detected corner ${index}, but detection produced ` +
          `${detected.length} corners (1..${detected.length}). Overrides address the ` +
          `DETECTED numbering — recut them if detection changed.`,
      );
    }
    return c;
  };

  // Consumed detected indices, so an untouched corner passes through and a
  // corner named by two operations is caught rather than silently duplicated.
  const consumed = new Set<number>();
  const claim = (index: number, op: string): void => {
    if (consumed.has(index)) {
      throw new CornerOverrideError(`detected corner ${index} is claimed by more than one operation (${op})`);
    }
    consumed.add(index);
  };

  const pieces: Piece[] = [];
  const renames = new Map<number, string[]>();

  for (const operation of overrides.operations) {
    switch (operation.op) {
      case "rename": {
        require(operation.index, "rename");
        renames.set(operation.index, operation.names);
        break;
      }

      case "drop": {
        require(operation.index, "drop");
        claim(operation.index, "drop");
        break;
      }

      case "merge": {
        const parts = operation.indices.map((i) => require(i, "merge"));
        for (const i of operation.indices) claim(i, "merge");

        const first = parts[0]!;
        const last = parts[parts.length - 1]!;
        // The merged corner keeps the direction and apex of whichever part turned
        // hardest — that is the corner; the rest is entry and exit around it.
        const dominant = parts.reduce((a, b) => (b.peakSteerRad > a.peakSteerRad ? b : a));
        const minSpeed = Math.min(...parts.map((p) => p.minSpeedMps));

        pieces.push({
          entryPct: first.entryPct,
          apexPct: dominant.apexPct,
          exitPct: last.exitPct,
          direction: dominant.direction,
          severity: severityOf(minSpeed, dominant.peakSteerRad),
          names: operation.names ?? [],
          sortKey: first.entryPct,
        });
        break;
      }

      case "split": {
        const source = require(operation.index, "split");
        claim(operation.index, "split");

        const cuts = [...operation.atPct].sort((a, b) => a - b);
        for (const cut of cuts) {
          if (!within(source.entryPct, source.exitPct, cut)) {
            throw new CornerOverrideError(
              `split at pct ${cut} is outside detected corner ${operation.index} ` +
                `(${source.entryPct.toFixed(4)}..${source.exitPct.toFixed(4)})`,
            );
          }
        }

        const bounds = [source.entryPct, ...cuts, source.exitPct];
        for (let i = 0; i < bounds.length - 1; i++) {
          const from = bounds[i]!;
          const to = bounds[i + 1]!;
          const measured = measure(lap, from, to);
          // The apex comes back as a grid cell centre, and a cut landing near a
          // cell boundary can put that a fraction before `from` — which would
          // leave a corner whose apex sits outside itself, and PHASE_PCT would
          // then aim apex and throttle notes just short of the corner.
          const apexPct =
            measured !== null && within(from, to, measured.apexPct)
              ? measured.apexPct
              : midPct(from, to);

          pieces.push({
            entryPct: from,
            apexPct,
            exitPct: to,
            direction: measured?.direction ?? source.direction,
            severity: measured?.severity ?? source.severity,
            names: operation.names?.[i] ?? [],
            sortKey: from,
          });
        }
        break;
      }

      case "insert": {
        pieces.push({
          entryPct: operation.entryPct,
          apexPct: operation.apexPct,
          exitPct: operation.exitPct,
          direction: operation.direction,
          severity: operation.severity,
          names: operation.names ?? [],
          sortKey: operation.entryPct,
        });
        break;
      }
    }
  }

  for (const c of detected) {
    if (consumed.has(c.index)) continue;
    const piece = pieceOf(c);
    piece.names = renames.get(c.index) ?? [];
    pieces.push(piece);
  }

  pieces.sort((a, b) => a.sortKey - b.sortKey);

  return pieces.map((p, i) => ({
    index: i + 1,
    names: p.names,
    entryPct: wrapPct(p.entryPct),
    apexPct: wrapPct(p.apexPct),
    exitPct: wrapPct(p.exitPct),
    direction: p.direction,
    severity: p.severity,
  }));

  /** Direction and apex for a split piece, measured rather than inherited. */
  function measure(
    source: typeof lap,
    from: number,
    to: number,
  ): { apexPct: number; direction: "left" | "right"; severity: number } | null {
    if (source === undefined) return null;
    const { gridSize, speedMps, steerRad } = source;
    const a = Math.floor(wrapPct(from) * gridSize);
    const b = Math.floor(wrapPct(to) * gridSize);
    const span = ((b - a + gridSize) % gridSize) + 1;

    let apex = a;
    let minSpeed = Number.POSITIVE_INFINITY;
    let sum = 0;
    let peak = 0;
    for (let k = 0; k < span; k++) {
      const i = (a + k) % gridSize;
      if (speedMps[i]! < minSpeed) {
        minSpeed = speedMps[i]!;
        apex = i;
      }
      sum += steerRad[i]!;
      peak = Math.max(peak, Math.abs(steerRad[i]!));
    }

    const mean = sum / span;
    // A split exists to separate two senses of turn, so each piece reads its own
    // direction off its own steering rather than inheriting the region's average
    // — which is precisely the average that hid the corner in the first place.
    const detectedDirection = detected.find((c) => within(c.entryPct, c.exitPct, from));
    const rightIsNegative =
      detectedDirection === undefined
        ? true
        : (detectedDirection.direction === "right") === detectedDirection.meanSteerRad < 0;
    const isRight = rightIsNegative ? mean < 0 : mean > 0;

    return {
      apexPct: (apex + 0.5) / gridSize,
      direction: isRight ? "right" : "left",
      severity: severityOf(minSpeed, peak),
    };
  }
}

/** Whether `p` lies inside `from..to`, going in the racing direction. */
function within(from: number, to: number, p: number): boolean {
  const span = (to - from + 1) % 1;
  const offset = (p - from + 1) % 1;
  return offset <= span + 1e-9;
}

function midPct(from: number, to: number): number {
  return wrapPct(from + ((to - from + 1) % 1) / 2);
}
