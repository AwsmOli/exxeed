/**
 * Branded units — SPEC.md §3.
 *
 * "All internal data and all engine math are SI: metres, metres/second, radians,
 * seconds. LapDistPct stays 0..1. Conversion to km/h happens ONLY in overlay
 * render code. Do not store kph anywhere."
 *
 * That is a convention until you brand it, and then it is a type error. Given how
 * many of §12's pitfalls are unit and coordinate mistakes, this is the cheapest
 * insurance in the codebase.
 *
 * Keep the constructors at I/O boundaries only — the telemetry adapter, the
 * repository layer, and render code. Anywhere else, if you are reaching for
 * `mps(x)` you are probably about to launder a unit mistake past the compiler.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Lap position, 0..1.
 *
 * The iRacing SDK reports `LapDistPct` with a unit string of `"%"`, but the value
 * is genuinely 0..1. Do not "fix" it by dividing by 100. (SPEC.md §3.) */
export type Pct = Brand<number, "Pct">;

/** Distance along or across the track, in metres. */
export type Metres = Brand<number, "Metres">;

/** Speed, metres per second. Never kph — see SPEC.md §12. */
export type Mps = Brand<number, "Mps">;

/** Duration, seconds. */
export type Seconds = Brand<number, "Seconds">;

/** Angle, radians. `SteeringWheelAngle` arrives in radians already. */
export type Radians = Brand<number, "Radians">;

export const pct = (n: number): Pct => n as Pct;
export const metres = (n: number): Metres => n as Metres;
export const mps = (n: number): Mps => n as Mps;
export const seconds = (n: number): Seconds => n as Seconds;
export const radians = (n: number): Radians => n as Radians;

/**
 * The only sanctioned m/s → km/h conversion in the repo. Overlay render code
 * only; if you are calling this outside a draw call, stop. (SPEC.md §7.1.)
 */
export const toKph = (v: Mps): number => v * 3.6;
