/**
 * Track identity — SPEC.md §4.0.
 *
 * Two distinct keys, and confusing them silently invalidates data:
 *
 *   TrackKey  identifies the physical track + layout. Stable across map
 *             regeneration.
 *   TrackRef  identifies a specific corner-NUMBERING of that track.
 *
 * Anything holding corner indices is keyed by TrackRef. Anything holding raw
 * telemetry is keyed by TrackKey — re-cutting a track map bumps `mapVersion`, and
 * that must not invalidate laps you already drove and recorded. This is the whole
 * reason ReferenceLap carries `trackKey` plus a separate `derivedForMapVersion`
 * rather than a TrackRef.
 *
 * Never key on track display name (SPEC.md §12). Not stable, not unique.
 */

export type Sim = "iracing";

export interface TrackKey {
  readonly sim: Sim;
  readonly trackId: number;
  readonly configId: string;
}

export interface TrackRef extends TrackKey {
  readonly mapVersion: number;
}

/** Widen a TrackRef to the TrackKey it contains. There is no inverse — recovering
 *  a corner numbering from a physical track requires knowing which map version. */
export const trackKeyOf = (ref: TrackRef): TrackKey => ({
  sim: ref.sim,
  trackId: ref.trackId,
  configId: ref.configId,
});

/** Stable string form, for map keys and file paths. */
export const trackKeyId = (k: TrackKey): string => `${k.sim}/${k.trackId}/${k.configId}`;

export const trackRefId = (r: TrackRef): string => `${trackKeyId(r)}/v${r.mapVersion}`;

export const trackKeyEquals = (a: TrackKey, b: TrackKey): boolean =>
  a.sim === b.sim && a.trackId === b.trackId && a.configId === b.configId;

export const trackRefEquals = (a: TrackRef, b: TrackRef): boolean =>
  trackKeyEquals(a, b) && a.mapVersion === b.mapVersion;
