import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunPosition, sunDirection, daylightHours, daySamples } from './solar.ts';

// Stony Ridge, Woking (GU22 0HW)
const LAT = 51.309915, LON = -0.578314;

test('summer solstice noon: sun due south, elevation = 90 − lat + 23.44', () => {
  // solar noon at longitude −0.578° is ~12:02 UTC plus the equation of time (−1.7 min on 21 Jun)
  const p = sunPosition(new Date(Date.UTC(2026, 5, 21, 12, 4)), LAT, LON);
  assert.ok(Math.abs(p.azimuth - 180) < 1.0, `azimuth ${p.azimuth}`);
  assert.ok(Math.abs(p.elevationGeometric - (90 - LAT + 23.44)) < 0.15, `elevation ${p.elevationGeometric}`);
});

test('winter solstice noon: low sun, still due south', () => {
  const p = sunPosition(new Date(Date.UTC(2026, 11, 21, 12, 0)), LAT, LON);
  assert.ok(Math.abs(p.azimuth - 180) < 1.5, `azimuth ${p.azimuth}`);
  assert.ok(Math.abs(p.elevationGeometric - (90 - LAT - 23.44)) < 0.15, `elevation ${p.elevationGeometric}`);
});

test('equinox: sun rises near east and sets near west', () => {
  const samples = daySamples(new Date(Date.UTC(2026, 2, 20)), LAT, LON, 5, 0);
  const first = samples[0].position, last = samples[samples.length - 1].position;
  assert.ok(Math.abs(first.azimuth - 90) < 4, `sunrise azimuth ${first.azimuth}`);
  assert.ok(Math.abs(last.azimuth - 270) < 4, `sunset azimuth ${last.azimuth}`);
});

test('day length: ~16.6 h in June, ~7.8 h in December at 51.3°N', () => {
  const june = daylightHours(new Date(Date.UTC(2026, 5, 21)), LAT, LON);
  const dec = daylightHours(new Date(Date.UTC(2026, 11, 21)), LAT, LON);
  assert.ok(Math.abs(june - 16.65) < 0.25, `june ${june}`);
  assert.ok(Math.abs(dec - 7.85) < 0.25, `december ${dec}`);
});

test('midnight: sun below the horizon', () => {
  const p = sunPosition(new Date(Date.UTC(2026, 5, 21, 0, 0)), LAT, LON);
  assert.ok(p.elevation < -10, `elevation ${p.elevation}`);
});

test('sunDirection: south at noon → vector points +Z (south) and up; east → +X', () => {
  const south = sunDirection({ azimuth: 180, elevation: 45, elevationGeometric: 45 });
  assert.ok(south[2] > 0.7 && Math.abs(south[0]) < 1e-9 && Math.abs(south[1] - Math.SQRT1_2) < 1e-9);
  const east = sunDirection({ azimuth: 90, elevation: 0, elevationGeometric: 0 });
  assert.ok(Math.abs(east[0] - 1) < 1e-9 && Math.abs(east[2]) < 1e-9);
});
