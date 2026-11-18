/**
 * Solar position for garden sun-hour maps. NOAA's simplified algorithm (Jean Meeus, "Astronomical
 * Algorithms"), accurate to roughly 0.01° for 1900–2100, which is far finer than a compass-aligned
 * scan needs. No dependencies; runs in the browser, Node and tests.
 *
 * Conventions: azimuth in degrees clockwise from true north (0 N, 90 E, 180 S, 270 W); elevation
 * in degrees above the horizon (refraction-corrected). Dates are UTC instants.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface SunPosition {
  /** degrees clockwise from true north */
  azimuth: number;
  /** degrees above the horizon, including atmospheric refraction near the horizon */
  elevation: number;
  /** geometric elevation without refraction */
  elevationGeometric: number;
}

/** Julian day for a UTC instant */
export function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/** Sun position for a UTC instant at a latitude/longitude (degrees, east positive). */
export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  const jd = julianDay(date);
  const t = (jd - 2_451_545) / 36_525; // Julian centuries since J2000.0
  const L0 = norm360(280.46646 + t * (36_000.76983 + 0.0003032 * t)); // geometric mean longitude
  const M = norm360(357.52911 + t * (35_999.05029 - 0.0001537 * t)); // mean anomaly
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t); // eccentricity
  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * t) + Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliquity0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = obliquity0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLong * RAD));
  // equation of time, minutes
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const L0r = L0 * RAD;
  const eot = 4 * DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
  const minutesUTC = (date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60_000);
  const trueSolarTime = norm(minutesUTC + eot + 4 * longitude, 1440);
  const hourAngle = (trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180) * RAD;
  const lat = latitude * RAD;
  const cosZenith = clamp(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle), -1, 1);
  const zenith = Math.acos(cosZenith);
  const elevationGeometric = 90 - zenith * DEG;
  // azimuth, clockwise from north
  const sinZ = Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(sinZ) < 1e-9) azimuth = 180;
  else {
    const cosAz = clamp((Math.sin(lat) * cosZenith - Math.sin(declination)) / (Math.cos(lat) * sinZ), -1, 1);
    azimuth = Math.acos(cosAz) * DEG;
    azimuth = hourAngle > 0 ? norm360(azimuth + 180) : norm360(540 - azimuth);
  }
  return { azimuth, elevation: elevationGeometric + refraction(elevationGeometric), elevationGeometric };
}

/** Atmospheric refraction correction in degrees (NOAA), for a geometric elevation in degrees. */
export function refraction(elevation: number): number {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * RAD);
  let r: number;
  if (elevation > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevation > -0.575) r = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  else r = -20.774 / te;
  return r / 3600;
}

/** Unit vector pointing *towards* the sun in a +Y-up, right-handed frame whose −Z axis is true north
 *  and +X is east (the garden session frame after north alignment). */
export function sunDirection(p: SunPosition): [number, number, number] {
  const az = p.azimuth * RAD, el = p.elevation * RAD;
  const horizontal = Math.cos(el);
  return [Math.sin(az) * horizontal, Math.sin(el), -Math.cos(az) * horizontal];
}

/**
 * Sun samples for one civil day: every `stepMinutes` from 00:00 to 24:00 UTC, keeping only
 * instants with the sun above `minElevation` degrees (default 0.5°, so grazing light at the
 * horizon doesn't count: it's blocked by any real horizon anyway).
 */
export function daySamples(dateUTC: Date, latitude: number, longitude: number, stepMinutes = 15, minElevation = 0.5) {
  const start = Date.UTC(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate());
  const out: { time: Date; position: SunPosition; hours: number }[] = [];
  for (let m = 0; m < 1440; m += stepMinutes) {
    const time = new Date(start + m * 60_000);
    const position = sunPosition(time, latitude, longitude);
    if (position.elevation >= minElevation) out.push({ time, position, hours: stepMinutes / 60 });
  }
  return out;
}

/** Hours between first and last sample above the horizon (approximate day length). */
export function daylightHours(dateUTC: Date, latitude: number, longitude: number, stepMinutes = 5): number {
  return daySamples(dateUTC, latitude, longitude, stepMinutes, 0).length * stepMinutes / 60;
}

function norm360(d: number) { return norm(d, 360); }
function norm(v: number, m: number) { const r = v % m; return r < 0 ? r + m : r; }
function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }
