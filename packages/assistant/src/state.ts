/**
 * What the assistant can see of the app — the one thing main feeds.
 *
 * Main already builds a `RaceView` for the overlays five times a second and
 * holds a `SessionStatus` for the control window. This keeps the latest of
 * each, so a tool call answers from what the panels are showing rather than
 * reaching into the telemetry loop, and nothing in that loop ever waits on a
 * model.
 */

import type { RaceView, SessionStatus } from "@exxeed/overlays";

import { GapHistory } from "./history.js";

export type SessionInfo = Pick<SessionStatus, "phase" | "trackName" | "carName" | "testMode">;

/**
 * A race view older than this is not live. The loop sends one every 200 ms, so
 * a few seconds of silence means the sim has gone, and the last fuel level it
 * reported is a number about the past.
 */
const STALE_MS = 3000;

/** There is nothing live to answer from. The message is what the driver hears. */
export class NoLiveData extends Error {}

export class AssistantState {
  readonly history = new GapHistory();
  readonly #now: () => number;
  #race: RaceView | null = null;
  #raceAt = 0;
  #session: SessionInfo = { phase: "stopped", trackName: null, carName: null, testMode: false };

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** `tS` is the telemetry clock, seconds — what the gap history is timed on. */
  onRace(tS: number, view: RaceView | null): void {
    this.#race = view;
    this.#raceAt = this.#now();
    this.history.record(tS, view);
  }

  onSession(session: SessionInfo): void {
    this.#session = session;
  }

  get session(): SessionInfo {
    return this.#session;
  }

  /** The live race view, or `NoLiveData` saying why there is none. */
  race(): RaceView {
    if (this.#race !== null && this.#now() - this.#raceAt <= STALE_MS) return this.#race;
    throw new NoLiveData(
      this.#session.phase === "running"
        ? "Connected, but the sim is not sending race data right now."
        : "No live session: Exxeed is not connected to the sim.",
    );
  }
}
