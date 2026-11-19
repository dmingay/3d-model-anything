import * as THREE from 'three';
import type { BuiltRoom } from '../../../packages/room-runtime/types';

/**
 * Posed scan photos in the scene, the way the capture app shows them: a small card hanging
 * 0.45 m in front of where the phone was, facing back at the camera position, with a thin
 * frustum line to the pose. Textures are small (192 px wide) so a hundred cards stay cheap;
 * click a card for the full photo.
 */
interface Hosts { toggle: HTMLButtonElement; lightbox: HTMLElement; photoBase: string; invalidate: () => void }

const DISTANCE = 0.45;
// iPhone wide camera, upright (portrait after EXIF): half-angles from fx≈1332 px over 1440×1920
const HALF_W = Math.atan(720 / 1332), HALF_H = Math.atan(960 / 1332);

export class PhotosView {
  private group = new THREE.Group();
  private cards = new Map<THREE.Mesh, { url: string; index: number }>();
  private room?: BuiltRoom;
  private on = false;
  private loaded = false;

  constructor(private hosts: Hosts) {
    this.group.name = 'scan-photos';
    hosts.toggle.addEventListener('click', () => this.set(!this.on));
    hosts.lightbox.addEventListener('click', () => { hosts.lightbox.hidden = true; });
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !hosts.lightbox.hidden) hosts.lightbox.hidden = true; });
  }

  show(room: BuiltRoom, on: boolean) {
    this.room = room; this.loaded = false;
    this.group.clear(); this.cards.clear();
    this.hosts.toggle.hidden = !room.scanPhotos;
    this.set(on);
  }

  hide() {
    this.room?.group.remove(this.group);
    this.group.clear(); this.cards.clear();
    this.room = undefined; this.on = false; this.loaded = false;
    this.hosts.toggle.classList.remove('active'); this.hosts.toggle.setAttribute('aria-pressed', 'false');
  }

  pick(raycaster: THREE.Raycaster): boolean {
    if (!this.on || !this.cards.size) return false;
    const hit = raycaster.intersectObjects([...this.cards.keys()], false)[0];
    if (!hit) return false;
    const card = this.cards.get(hit.object as THREE.Mesh);
    if (!card) return false;
    const img = this.hosts.lightbox.querySelector('img')!;
    img.src = card.url;
    this.hosts.lightbox.querySelector('p')!.textContent = `Photo ${card.index} · click to close`;
    this.hosts.lightbox.hidden = false;
    return true;
  }

  private set(on: boolean) {
    this.on = on;
    this.hosts.toggle.classList.toggle('active', on); this.hosts.toggle.setAttribute('aria-pressed', String(on));
    if (!this.room) return;
    if (on) { if (!this.loaded) this.build(); this.room.group.add(this.group); }
    else this.room.group.remove(this.group);
    const url = new URL(location.href);
    if (on) url.searchParams.set('photos', '1'); else url.searchParams.delete('photos');
    history.replaceState(null, '', url);
    this.hosts.invalidate();
  }

  private build() {
    const set = this.room?.scanPhotos;
    if (!set) return;
    this.loaded = true;
    const w = 2 * DISTANCE * Math.tan(HALF_W), h = 2 * DISTANCE * Math.tan(HALF_H);
    const geometry = new THREE.PlaneGeometry(w, h);
    const lines: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const p of set.photos) {
      const eye = new THREE.Vector3(...p.position);
      const fwd = new THREE.Vector3(...p.forward).normalize();
      const center = eye.clone().addScaledVector(fwd, DISTANCE);
      const material = new THREE.MeshBasicMaterial({ color: '#8a9a8c', side: THREE.DoubleSide, toneMapped: false });
      const card = new THREE.Mesh(geometry, material);
      card.position.copy(center);
      // face the viewer standing at the camera pose; keep the card upright (photos are EXIF-upright)
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      const cardUp = new THREE.Vector3().crossVectors(right, fwd).normalize();
      card.matrix.makeBasis(right, cardUp, fwd.clone().negate()).setPosition(center);
      card.matrix.decompose(card.position, card.quaternion, card.scale);
      card.name = `photo-${p.index}`;
      this.group.add(card);
      const url = `${this.hosts.photoBase}${set.base}${p.file}`;
      this.cards.set(card, { url, index: p.index });
      // frustum: pose to the four card corners
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const corner = center.clone().addScaledVector(right, sx * w / 2).addScaledVector(cardUp, sy * h / 2);
        lines.push(eye.x, eye.y, eye.z, corner.x, corner.y, corner.z);
      }
      void this.loadTexture(url, material);
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.group.add(new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: '#dfe7d8', transparent: true, opacity: 0.35 })));
  }

  private async loadTexture(url: string, material: THREE.MeshBasicMaterial) {
    try {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob, { resizeWidth: 192, resizeQuality: 'medium' });
      const texture = new THREE.CanvasTexture(bitmap as unknown as HTMLCanvasElement);
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 2;
      material.map = texture; material.color.set('#ffffff'); material.needsUpdate = true;
      this.hosts.invalidate();
    } catch { /* leave the grey card */ }
  }
}
