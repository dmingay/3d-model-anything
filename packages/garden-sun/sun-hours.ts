import * as THREE from 'three';
import { daySamples, sunDirection, type SunPosition } from './solar';

/**
 * Hours of direct sun per vertex, by shadow-mapping the scene from each sun sample.
 *
 * For every sample (e.g. every 15 minutes of a chosen day) the scene is rendered from the sun
 * with an orthographic camera into a depth target; each vertex is then projected into that view
 * and counts as lit when nothing is closer to the sun along its ray. Summing the samples' hours
 * gives sun hours per vertex, which the viewer paints as a colour ramp.
 *
 * Geometry is the garden's own scan or model: fences, walls, hedges, the house, trees. Anything
 * not in the scene (a neighbour's tree off the edge of the scan) is not shadowing, so treat the
 * result as an upper bound near the scan's edges.
 *
 * Frame: +Y up, −Z true north, +X east (a north-aligned garden session). For scenes whose north
 * is elsewhere, pass `northBearing` = compass bearing of the scene's −Z axis (manifest
 * site.worldMinusZBearing) and the sun is rotated to match.
 */
export interface SunHoursOptions {
  latitude: number;
  longitude: number;
  /** UTC calendar day to sample (time of day ignored) */
  date: Date;
  /** minutes between samples (15 → 96 renders a day at most, ~60 in summer) */
  stepMinutes?: number;
  /** compass bearing (° clockwise from north) of the scene's −Z axis; 0 = already north-aligned */
  northBearing?: number;
  /** shadow map resolution; 2048 is sharp at garden scale */
  resolution?: number;
  /** push the comparison a little towards the sun to avoid self-shadow acne (metres) */
  bias?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SunHoursResult {
  /** per vertex of `target`, in the order of its position attribute */
  hours: Float32Array;
  /** total possible hours that day above the horizon (max of `hours`) */
  daylight: number;
  samples: number;
}

/**
 * Compute direct-sun hours for every vertex of `target`, shadowed by everything in `occluders`
 * (which should include `target` itself). Everything is in world space.
 */
export async function computeSunHours(renderer: THREE.WebGLRenderer, target: THREE.Mesh, occluders: THREE.Object3D[], opts: SunHoursOptions): Promise<SunHoursResult> {
  const step = opts.stepMinutes ?? 15;
  const res = opts.resolution ?? 2048;
  const bias = opts.bias ?? 0.03;
  const samples = daySamples(opts.date, opts.latitude, opts.longitude, step);
  const geometry = target.geometry;
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const count = positions.count;
  const hours = new Float32Array(count);
  if (!samples.length) return { hours, daylight: 0, samples: 0 };

  // world-space vertices once
  target.updateWorldMatrix(true, false);
  const world = new Float32Array(count * 3);
  const worldNormals = normals ? new Float32Array(count * 3) : undefined;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(target.matrixWorld);
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(positions, i).applyMatrix4(target.matrixWorld);
    world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
    if (normals && worldNormals) {
      n.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      worldNormals[i * 3] = n.x; worldNormals[i * 3 + 1] = n.y; worldNormals[i * 3 + 2] = n.z;
    }
  }

  // bounds of everything that casts or receives
  const bounds = new THREE.Box3();
  for (const o of occluders) bounds.expandByObject(o);
  bounds.expandByObject(target);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2 + 1;

  // depth-only scene: the occluders, rendered with a cheap material into a float depth
  const depthScene = new THREE.Scene();
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const stash: { o: THREE.Object3D; parent: THREE.Object3D | null }[] = [];
  const rt = new THREE.WebGLRenderTarget(res, res, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.UnsignedByteType });
  const sunCam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, radius * 2 + 1);
  const pixels = new Uint8Array(res * res * 4);
  const north = THREE.MathUtils.degToRad(opts.northBearing ?? 0);
  const prevTarget = renderer.getRenderTarget();
  const prevOverride = depthScene.overrideMaterial;
  depthScene.overrideMaterial = depthMaterial;
  const clipPos = new THREE.Vector3();
  const sunDir = new THREE.Vector3();
  try {
    for (const o of occluders) { stash.push({ o, parent: o.parent }); depthScene.add(o); }
    for (let s = 0; s < samples.length; s++) {
      const { position, hours: h } = samples[s];
      sunDir.fromArray(sunDirection(position));
      // scene −Z has compass bearing `north`: rotate the (north-frame) sun vector by −north about +Y
      if (north) sunDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), -north);
      sunCam.position.copy(center).addScaledVector(sunDir, radius);
      sunCam.up.set(0, 1, 0);
      if (Math.abs(sunDir.y) > 0.999) sunCam.up.set(0, 0, -1);
      sunCam.lookAt(center);
      sunCam.updateMatrixWorld(true);
      sunCam.updateProjectionMatrix();
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, true);
      renderer.render(depthScene, sunCam);
      await renderer.readRenderTargetPixelsAsync(rt, 0, 0, res, res, pixels);
      const viewProj = new THREE.Matrix4().multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);
      for (let i = 0; i < count; i++) {
        // back-facing surfaces (relative to the sun) are in their own shadow
        if (worldNormals) {
          const ndotl = worldNormals[i * 3] * sunDir.x + worldNormals[i * 3 + 1] * sunDir.y + worldNormals[i * 3 + 2] * sunDir.z;
          if (ndotl <= 0) continue;
        }
        clipPos.set(world[i * 3] + sunDir.x * bias, world[i * 3 + 1] + sunDir.y * bias, world[i * 3 + 2] + sunDir.z * bias).applyMatrix4(viewProj);
        const px = Math.floor((clipPos.x * 0.5 + 0.5) * res), py = Math.floor((clipPos.y * 0.5 + 0.5) * res);
        if (px < 0 || py < 0 || px >= res || py >= res) continue;
        const k = (py * res + px) * 4;
        // unpack RGBA depth (orthographic: linear in NDC z)
        const stored = (pixels[k] / 255) + (pixels[k + 1] / 255) / 255 + (pixels[k + 2] / 255) / 65025 + (pixels[k + 3] / 255) / 16_581_375;
        const own = clipPos.z * 0.5 + 0.5;
        if (own <= stored + 1e-4) hours[i] += h;
      }
      opts.onProgress?.(s + 1, samples.length);
    }
  } finally {
    for (const { o, parent } of stash) { depthScene.remove(o); parent?.add(o); }
    depthScene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);
    rt.dispose();
    depthMaterial.dispose();
  }
  const daylight = samples.reduce((a, s) => a + s.hours, 0);
  return { hours, daylight, samples: samples.length };
}

/** Viridis-like ramp from shade (deep blue) through green to full sun (yellow), as a vertex colour array */
export function sunHoursColors(hours: Float32Array, maxHours: number): Float32Array {
  const colors = new Float32Array(hours.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < hours.length; i++) {
    const t = maxHours > 0 ? Math.min(1, hours[i] / maxHours) : 0;
    sunRamp(t, c);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  return colors;
}

/** 0 = full shade … 1 = full sun */
export function sunRamp(t: number, out = new THREE.Color()): THREE.Color {
  const stops: [number, string][] = [[0, '#2b2d6b'], [0.25, '#2a6f97'], [0.5, '#35a07a'], [0.75, '#9fd35a'], [1, '#f8e45c']];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = new THREE.Color(stops[i - 1][1]), b = new THREE.Color(stops[i][1]);
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return out.copy(a).lerp(b, f);
    }
  }
  return out.set(stops[stops.length - 1][1]);
}

/** Gardening bands used in plant labels (RHS-style): full sun ≥ 6 h, partial 3–6 h, shade < 3 h, in midsummer. */
export function sunBand(hours: number): 'full sun' | 'partial shade' | 'shade' {
  return hours >= 6 ? 'full sun' : hours >= 3 ? 'partial shade' : 'shade';
}

export type { SunPosition };
