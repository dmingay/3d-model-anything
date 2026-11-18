import * as THREE from 'three';
import type { BuiltRoom } from '../../../packages/room-runtime/types';
import { computeSunHours, sunHoursColors, sunBand } from '../../../packages/garden-sun/sun-hours';

/**
 * Sun-hours view for gardens: colours a room's `sun.receivers` by hours of direct sun on a chosen
 * day. Computed once per (room, day) and cached; toggled by swapping the receivers' materials.
 */
export const SUN_DAYS: { id: string; label: string; month: number; day: number }[] = [
  { id: 'mar', label: 'Spring equinox · 20 Mar', month: 2, day: 20 },
  { id: 'may', label: 'Mid May', month: 4, day: 15 },
  { id: 'jun', label: 'Midsummer · 21 Jun', month: 5, day: 21 },
  { id: 'aug', label: 'Mid August', month: 7, day: 15 },
  { id: 'sep', label: 'Autumn equinox · 22 Sep', month: 8, day: 22 },
  { id: 'dec', label: 'Midwinter · 21 Dec', month: 11, day: 21 },
];

interface Computed { hours: Float32Array[]; daylight: number; max: number; materials: THREE.MeshBasicMaterial[] }

export class SunView {
  private cache = new Map<string, Computed>();
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private active?: { room: BuiltRoom; day: string };
  constructor(private renderer: THREE.WebGLRenderer) {}

  get isActive() { return !!this.active; }

  /** Colour the room by sun hours for `dayId`; resolves with a one-line summary for the status area. */
  async show(room: BuiltRoom, dayId: string, onProgress?: (p: number) => void): Promise<string> {
    const site = room.sun;
    if (!site) throw new Error('This room has no site (latitude, longitude, north) for sun hours.');
    const day = SUN_DAYS.find(d => d.id === dayId) ?? SUN_DAYS[2];
    const key = `${room.group.uuid}:${day.id}`;
    let computed = this.cache.get(key);
    if (!computed) {
      const year = new Date().getUTCFullYear();
      const date = new Date(Date.UTC(year, day.month, day.day));
      const hours: Float32Array[] = [];
      let daylight = 0;
      const n = site.receivers.length;
      for (const [i, mesh] of site.receivers.entries()) {
        const r = await computeSunHours(this.renderer, mesh, site.occluders, {
          latitude: site.latitude, longitude: site.longitude, date, northBearing: site.northBearing, stepMinutes: 15,
          onProgress: (done, total) => onProgress?.((i + done / total) / n),
        });
        hours.push(r.hours);
        daylight = Math.max(daylight, r.daylight);
      }
      const max = daylight;
      const materials = site.receivers.map((mesh, i) => {
        const colors = sunHoursColors(hours[i], max);
        mesh.geometry.setAttribute('sunColor', new THREE.BufferAttribute(colors, 3));
        return new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide });
      });
      // vertexColors reads the 'color' attribute; alias without clobbering any real colours
      for (const mesh of site.receivers) {
        if (!mesh.geometry.getAttribute('color')) mesh.geometry.setAttribute('color', mesh.geometry.getAttribute('sunColor'));
      }
      computed = { hours, daylight, max, materials };
      this.cache.set(key, computed);
    }
    this.hide();
    for (const [i, mesh] of site.receivers.entries()) {
      this.originals.set(mesh, mesh.material);
      mesh.geometry.setAttribute('color', mesh.geometry.getAttribute('sunColor'));
      mesh.material = computed.materials[i];
    }
    this.active = { room, day: day.id };
    return summarize(computed, day.label);
  }

  hide() {
    for (const [mesh, material] of this.originals) mesh.material = material;
    this.originals.clear();
    this.active = undefined;
  }

  /** hours at a world point (nearest receiver vertex), for the hover/double-click readout */
  hoursAt(point: THREE.Vector3): { hours: number; band: string } | undefined {
    if (!this.active) return;
    const site = this.active.room.sun!;
    const computed = this.cache.get(`${this.active.room.group.uuid}:${this.active.day}`);
    if (!computed) return;
    let best = Infinity, hours = 0;
    const v = new THREE.Vector3();
    for (const [i, mesh] of site.receivers.entries()) {
      const pos = mesh.geometry.getAttribute('position');
      for (let k = 0; k < pos.count; k++) {
        const d = v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld).distanceToSquared(point);
        if (d < best) { best = d; hours = computed.hours[i][k]; }
      }
    }
    return best < 0.25 ? { hours, band: sunBand(hours) } : undefined;
  }
}

function summarize(c: Computed, label: string) {
  const all = Array.from(c.hours.flatMap(h => Array.from(h)));
  const sunny = all.filter(h => h >= 6).length / all.length, shady = all.filter(h => h < 3).length / all.length;
  return `${label}: up to ${c.daylight.toFixed(1)} h of sun · ${Math.round(sunny * 100)}% full sun, ${Math.round(shady * 100)}% shade`;
}
