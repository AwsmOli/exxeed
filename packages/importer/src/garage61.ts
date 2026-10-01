/**
 * The Garage 61 API — laps and their telemetry, for maps and reference laps.
 *
 * Only documented v1 endpoints (spec: https://garage61.net/api/openapi/v1.json);
 * their docs ask API users not to call the web app's internal ones. A personal
 * access token sees the driver's own laps and their teammates'; seeing every
 * visible lap needs Garage 61 to approve the application (TODO, reference lap
 * source).
 *
 * The token is the caller's to keep: it is passed in, never stored here.
 */

const BASE = "https://garage61.net/api/v1";
const TIMEOUT_MS = 30000;

export class Garage61Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "Garage61Error";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How many times a rate-limited request waits and tries again before giving up. */
const MAX_RETRIES = 3;

async function request(
  token: string,
  path: string,
  params?: Record<string, string | number | boolean>,
  attempt = 0,
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return response;
  // Rate limited: wait as long as Garage 61 says, then try again. A run over
  // hundreds of tracks hits the limit by design, and should just slow down.
  if (response.status === 429 && attempt < MAX_RETRIES) {
    const seconds = Number(response.headers.get("retry-after"));
    await sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000);
    return request(token, path, params, attempt + 1);
  }
  const body = await response.text().catch(() => "");
  const detail = /"(error_message|message)"\s*:\s*"([^"]+)"/.exec(body)?.[2];
  if (response.status === 401) throw new Garage61Error("Garage 61 did not accept the token", 401);
  if (response.status === 429) {
    throw new Garage61Error(`Garage 61's rate limit was hit; try again in ${response.headers.get("retry-after") ?? "a minute"}`, 429);
  }
  throw new Garage61Error(`Garage 61: ${detail ?? `HTTP ${response.status}`}`, response.status);
}

const json = async <T>(token: string, path: string, params?: Record<string, string | number | boolean>): Promise<T> =>
  (await (await request(token, path, params)).json()) as T;

export interface Garage61User {
  readonly id: string;
  readonly name: string;
}

export interface Garage61Track {
  readonly id: number;
  readonly name: string;
  readonly variant: string;
  /** iRacing's own TrackID, which names the layout uniquely. */
  readonly iracingTrackId: number | null;
}

export interface Garage61Car {
  readonly id: number;
  readonly name: string;
  /** iRacing's numeric car id. */
  readonly iracingCarId: number | null;
}

export interface Garage61Lap {
  readonly id: string;
  readonly driver: string;
  readonly driverRating: number | null;
  readonly car: Garage61Car;
  readonly track: Garage61Track;
  readonly startTime: string;
  readonly lapTimeS: number;
  readonly clean: boolean;
  readonly offtrack: boolean;
  readonly pitlane: boolean;
  readonly trackTempC: number | null;
  readonly canViewTelemetry: boolean;
}

type RawTrack = { id: number; name: string; variant: string; platform: string; platform_id: string };
type RawCar = { id: number; name: string; platform: string; platform_id: string };

const platformId = (platform: string, id: string): number | null =>
  platform === "iracing" && /^\d+$/.test(id) ? Number(id) : null;

const toTrack = (t: RawTrack): Garage61Track => ({
  id: t.id,
  name: t.name,
  variant: t.variant,
  iracingTrackId: platformId(t.platform, t.platform_id),
});
const toCar = (c: RawCar): Garage61Car => ({ id: c.id, name: c.name, iracingCarId: platformId(c.platform, c.platform_id) });

/** Who the token belongs to — also the check that it works. */
export async function garage61Me(token: string): Promise<Garage61User> {
  const me = await json<{ id: string; firstName?: string; lastName?: string; nickName?: string }>(token, "/me");
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.nickName || "Garage 61 user";
  return { id: me.id, name };
}

export async function garage61Tracks(token: string): Promise<Garage61Track[]> {
  const r = await json<{ items: RawTrack[] }>(token, "/tracks", { platform: "iracing" });
  return r.items.map(toTrack).sort((a, b) => `${a.name} ${a.variant}`.localeCompare(`${b.name} ${b.variant}`));
}

export async function garage61Cars(token: string): Promise<Garage61Car[]> {
  const r = await json<{ items: RawCar[] }>(token, "/cars");
  return r.items.map(toCar).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Laps on a track, optionally in one car, that have telemetry to download —
 * fastest first. Only laps the token may see: by default the driver's own and
 * their teammates'.
 *
 * Filtered on each lap's `canViewTelemetry` rather than with the API's
 * `seeTelemetry` parameter: that one needs a Garage 61 Pro plan, while the CSV
 * download itself works on the free one.
 */
export async function garage61Laps(
  token: string,
  trackId: number,
  carId: number | null,
  options: {
    /**
     * Only the token owner's own laps (`drivers=me`). Without it the search
     * includes teammates' laps, which are theirs to share, not the owner's.
     */
    readonly mineOnly?: boolean;
    readonly limit?: number;
  } = {},
): Promise<Garage61Lap[]> {
  // Garage 61 returns clean, full laps by default — one personal best per
  // driver — which is what a map or a reference lap wants.
  const params: Record<string, string | number | boolean> = { tracks: trackId, limit: options.limit ?? 100 };
  if (carId !== null) params["cars"] = carId;
  if (options.mineOnly === true) params["drivers"] = "me";
  const r = await json<{
    items: {
      id: string;
      driver?: { firstName?: string; lastName?: string } | null;
      driverRating?: number | null;
      car: RawCar;
      track: RawTrack;
      startTime: string;
      lapTime: number;
      clean: boolean;
      offtrack: boolean;
      pitlane: boolean;
      trackTemp?: number | null;
      canViewTelemetry: boolean;
    }[];
  }>(token, "/laps", params);
  return r.items
    .map((l) => ({
      id: l.id,
      driver: [l.driver?.firstName, l.driver?.lastName].filter(Boolean).join(" ") || "unknown driver",
      driverRating: l.driverRating ?? null,
      car: toCar(l.car),
      track: toTrack(l.track),
      startTime: l.startTime,
      lapTimeS: l.lapTime,
      clean: l.clean,
      offtrack: l.offtrack,
      pitlane: l.pitlane,
      trackTempC: l.trackTemp ?? null,
      canViewTelemetry: l.canViewTelemetry,
    }))
    .filter((l) => l.canViewTelemetry)
    .sort((a, b) => a.lapTimeS - b.lapTimeS);
}

/** A lap's telemetry as Garage 61's CSV — the same file the website exports. */
export async function garage61LapCsv(token: string, lapId: string): Promise<string> {
  if (!/^[0-9A-Z]{26}$/.test(lapId)) throw new Garage61Error("not a Garage 61 lap id", 400);
  return (await request(token, `/laps/${lapId}/csv`)).text();
}
