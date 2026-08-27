/**
 * Steering sign convention — SPEC.md §5 and §12.
 *
 * "The SDK gives SteeringWheelAngle in radians but the spec of which sign means
 * left is not something to assume — get it backwards and every corner's
 * `direction` inverts silently, with no crash to tell you."
 *
 * That silence is the whole problem. Corner detection (§5) derives `direction`
 * from `signOf(mean(steerSmooth))`, so a wrong constant here produces a track map
 * that is internally consistent, passes every test, and calls every right-hander
 * a left. Nothing downstream can catch it.
 *
 * So this is NOT guessed. It stays unmeasured until someone drives a known
 * right-hander on Windows and reads the sign — M0b.
 */

/**
 * Whether the constant below has been measured against a real lap yet.
 *
 * @todo M0b — flip to true once measured. See TODO.md.
 */
export const STEER_SIGN_MEASURED = false;

/**
 * Sign of `steerRad` when turning RIGHT.
 *
 * PLACEHOLDER. Do not trust this until STEER_SIGN_MEASURED is true. Corner
 * detection must refuse to write a track map while it is false, rather than
 * emitting one with every direction possibly inverted.
 */
export const STEER_SIGN_RIGHT: 1 | -1 = 1;

/**
 * Call this before writing anything that records a corner `direction`.
 * Deliberately a hard failure: a track map with inverted corner directions is
 * worse than no track map, because it looks fine.
 */
export function assertSteeringSignMeasured(): void {
  if (!STEER_SIGN_MEASURED) {
    throw new Error(
      "Steering sign convention has not been measured yet (SPEC.md §5, M0b). " +
        "Drive a known right-hander on Windows, read the sign of SteeringWheelAngle, " +
        "set STEER_SIGN_RIGHT and flip STEER_SIGN_MEASURED. Refusing to emit corner " +
        "directions from an assumed sign.",
    );
  }
}

/** Corner direction from a mean smoothed steering angle, once the sign is known. */
export function directionFromSteer(meanSteerRad: number): "left" | "right" {
  assertSteeringSignMeasured();
  return Math.sign(meanSteerRad) === STEER_SIGN_RIGHT ? "right" : "left";
}
