import * as THREE from 'three';
import type { BuiltRoom, Plant, PlantSet } from '../../../packages/room-runtime/types';

/**
 * Plants for garden scans. One pin per *plant* (proposals merged by the ID script), and a review
 * mode that walks the gardener through them one at a time over a top-down view: big photo,
 * merged candidates, confirm / type your own / not a plant, arrow keys to move on. Every identity
 * is a proposal until decided. Decisions persist per garden in localStorage and export as JSON.
 */
interface Decision { status: 'confirmed' | 'override' | 'rejected'; scientific?: string; common?: string | null; name?: string; at: string }

interface Hosts {
  count: HTMLElement; toggle: HTMLButtonElement; exportButton: HTMLButtonElement; reviewButton: HTMLButtonElement;
  review: HTMLElement; sheet: HTMLElement; progress: HTMLElement; closeButton: HTMLButtonElement; sunButton: HTMLButtonElement;
  photoBase: string;
  onReview: (on: boolean) => void;
  onFocus: (point: THREE.Vector3) => void;
  onSun: (on: boolean) => Promise<boolean>;
  invalidate: () => void;
}

const PIN_COLORS: Record<string, string> = { likely: '#c2d7a9', unsure: '#e9c46a', guess: '#9aa39c', confirmed: '#f3e9a8', override: '#9fd3ff', rejected: '#555b57' };

export class PlantsView {
  private pins = new THREE.Group();
  private sprites = new Map<THREE.Sprite, Plant>();
  private room?: BuiltRoom;
  private set?: PlantSet;
  private order: Plant[] = [];
  private decisions: Record<string, Decision> = {};
  private current?: Plant;
  private photoIndex = 0;
  private pinsOn = true;
  private reviewing = false;
  private onKey = (e: KeyboardEvent) => this.key(e);

  constructor(private hosts: Hosts) {
    this.pins.name = 'plant-pins';
    hosts.toggle.addEventListener('click', () => this.setPins(!this.pinsOn));
    hosts.exportButton.addEventListener('click', () => this.export());
    hosts.reviewButton.addEventListener('click', () => this.startReview());
    hosts.closeButton.addEventListener('click', () => this.endReview());
    hosts.sunButton.addEventListener('click', () => void this.toggleSun());
  }

  show(room: BuiltRoom) {
    const set = room.plants;
    if (!set) return;
    this.room = room; this.set = set;
    this.decisions = this.load(set.garden);
    this.pins.clear(); this.sprites.clear();
    // review order: strongest first, so the easy confirmations come before the puzzles
    this.order = [...set.plants].sort((a, b) => b.candidates[0].score - a.candidates[0].score);
    this.order.forEach((p, i) => {
      const sprite = this.makePin(i + 1, p);
      this.pins.add(sprite); this.sprites.set(sprite, p);
    });
    this.pins.visible = this.pinsOn;
    room.group.add(this.pins);
    this.hosts.toggle.classList.toggle('active', this.pinsOn);
    this.refreshCount();
  }

  hide() {
    if (this.reviewing) this.endReview();
    this.room?.group.remove(this.pins);
    this.pins.clear(); this.sprites.clear();
    this.room = undefined; this.set = undefined; this.current = undefined; this.order = [];
  }

  /** Select the pin under the cursor, if any. Opens review if it is not already open. */
  pick(raycaster: THREE.Raycaster): boolean {
    if (!this.pins.visible || !this.sprites.size) return false;
    const hit = raycaster.intersectObjects([...this.sprites.keys()], false)[0];
    if (!hit) return false;
    const p = this.sprites.get(hit.object as THREE.Sprite);
    if (!p) return false;
    if (!this.reviewing) this.startReview(p); else this.select(p);
    return true;
  }

  // ---------------------------------------------------------------- review flow
  startReview(at?: Plant) {
    if (!this.set || !this.order.length) return;
    if (!this.reviewing) {
      this.reviewing = true;
      this.hosts.review.hidden = false;
      this.hosts.onReview(true);
      window.addEventListener('keydown', this.onKey);
      this.setPins(true);
    }
    this.select(at ?? this.nextUnreviewed() ?? this.order[0]);
  }

  endReview() {
    if (!this.reviewing) return;
    this.reviewing = false;
    this.hosts.review.hidden = true;
    this.hosts.sheet.replaceChildren();
    window.removeEventListener('keydown', this.onKey);
    const prev = this.current; this.current = undefined;
    if (prev) this.repaintPin(prev);
    this.hosts.onReview(false);
  }

  private nextUnreviewed(from?: Plant): Plant | undefined {
    const start = from ? this.order.indexOf(from) + 1 : 0;
    for (let k = 0; k < this.order.length; k++) {
      const p = this.order[(start + k) % this.order.length];
      if (!this.decisions[p.id]) return p;
    }
    return undefined;
  }

  private step(delta: number) {
    if (!this.current) return;
    const i = this.order.indexOf(this.current);
    this.select(this.order[(i + delta + this.order.length) % this.order.length]);
  }

  private key(e: KeyboardEvent) {
    if (e.target instanceof HTMLElement && e.target.matches('input, textarea')) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); this.step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this.step(-1); }
    else if (e.key === 'Enter' && this.current) { e.preventDefault(); this.confirm(this.current, this.current.candidates[0]); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (this.current) this.decide(this.current, { status: 'rejected', at: new Date().toISOString() }); }
    else if (e.key === 'Escape') { e.preventDefault(); this.endReview(); }
  }

  private select(p: Plant) {
    const prev = this.current;
    this.current = p; this.photoIndex = 0;
    if (prev && prev !== p) this.repaintPin(prev);
    this.repaintPin(p);
    this.renderSheet();
    this.hosts.onFocus(new THREE.Vector3(...p.position));
  }

  private async toggleSun() {
    const on = !this.hosts.sunButton.classList.contains('active');
    this.hosts.sunButton.disabled = true;
    const active = await this.hosts.onSun(on);
    this.hosts.sunButton.disabled = false;
    this.hosts.sunButton.classList.toggle('active', active); this.hosts.sunButton.setAttribute('aria-pressed', String(active));
  }

  // ---------------------------------------------------------------- sheet
  private renderSheet() {
    const p = this.current, set = this.set;
    if (!p || !set) return;
    const d = this.decisions[p.id];
    const top = p.candidates[0];
    const chosen = d?.status === 'confirmed' ? p.candidates.find(c => c.scientific === d.scientific) ?? top : top;
    const rhs = chosen.rhs?.facts;
    const n = this.order.indexOf(p) + 1;
    const pct = Math.round(top.score * 100);
    const reviewed = Object.keys(this.decisions).filter(id => this.order.some(q => q.id === id)).length;
    this.hosts.progress.textContent = `Plant ${n} of ${this.order.length} · ${reviewed} reviewed`;
    const statusText = d?.status === 'confirmed' ? `Confirmed · ${d.common ?? d.scientific}`
      : d?.status === 'override' ? `Your identification · ${d.name}`
      : d?.status === 'rejected' ? 'Marked as not a plant'
      : p.confidence === 'likely' ? `Likely (${pct}%) — confirm, or pick another` : p.confidence === 'unsure' ? `Unsure (${pct}%) — which is it?` : `A guess (${pct}%) — it probably needs your name`;
    const facts = rhs ? [rhs.hardiness && `Hardiness ${rhs.hardiness}`, rhs.aspect && rhs.aspect.split(';')[0], rhs.soil && `Soil: ${rhs.soil}`, rhs.size && `Size ${rhs.size}`].filter(Boolean).join(' · ') : (chosen.rhs === null ? 'No RHS page for this name' : '');
    const title = d?.status === 'override' ? `${d.name}` : (chosen.common ? `${chosen.common}<i>${chosen.scientific}</i>` : `<i>${chosen.scientific}</i>`);
    const photos = p.photos.map(f => `${this.hosts.photoBase}${set.photoBase}${f}`);
    const sheet = this.hosts.sheet;
    sheet.innerHTML = `
      <div class="sheet-photo">
        <img class="main" alt="Scan photo of plant ${n}" src="${photos[this.photoIndex] ?? ''}">
        <span class="pin ${d?.status ?? p.confidence}">${n}</span>
        ${photos.length > 1 ? `<div class="strip">${photos.map((u, i) => `<img src="${u}" data-i="${i}" class="${i === this.photoIndex ? 'current' : ''}" alt="">`).join('')}</div>` : ''}
      </div>
      <div class="sheet-body">
        <div class="sheet-title">${title}</div>
        <div class="sheet-status ${d?.status ?? ''}">${statusText}</div>
        <div class="sheet-facts">${facts}</div>
        <div class="sheet-cands"></div>
        <div class="sheet-actions"><input type="text" placeholder="Or type what it is…" aria-label="Your identification"><button data-act="override">Set</button><button data-act="reject" title="Not a plant (Backspace)">Not a plant</button></div>
        <div class="sheet-nav">
          <button data-nav="-1" title="Previous (←)">‹ Prev</button>
          <button data-nav="1" title="Next (→)">Next ›</button>
          <span class="spacer"></span>
          <button data-nav="unreviewed" class="primary">Next unreviewed <kbd>→</kbd></button>
        </div>
      </div>`;
    const cands = sheet.querySelector('.sheet-cands')!;
    for (const c of p.candidates.slice(0, 5)) {
      const b = document.createElement('button');
      b.innerHTML = `${c.common ?? c.scientific}<small>${Math.round(c.score * 100)}%${(c.support ?? 1) > 1 ? ` ×${c.support}` : ''}</small>`;
      b.title = `${c.scientific} (${c.family})${c.rhs ? ` · RHS: ${c.rhs.botanical}` : ' · no RHS page'}`;
      b.classList.toggle('top', c === top);
      b.classList.toggle('chosen', d?.status === 'confirmed' && d.scientific === c.scientific);
      b.addEventListener('click', () => d?.status === 'confirmed' && d.scientific === c.scientific ? this.decide(p, undefined) : this.confirm(p, c));
      cands.append(b);
    }
    const input = sheet.querySelector<HTMLInputElement>('input')!;
    if (d?.status === 'override') input.value = d.name ?? '';
    const setName = () => { const name = input.value.trim(); if (name) this.decide(p, { status: 'override', name, at: new Date().toISOString() }); };
    sheet.querySelector('[data-act=override]')!.addEventListener('click', setName);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); setName(); } });
    sheet.querySelector('[data-act=reject]')!.addEventListener('click', () => this.decide(p, d?.status === 'rejected' ? undefined : { status: 'rejected', at: new Date().toISOString() }));
    sheet.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.nav === 'unreviewed') { const nx = this.nextUnreviewed(p); if (nx) this.select(nx); else this.hosts.progress.textContent = `All ${this.order.length} plants reviewed`; }
      else this.step(Number(b.dataset.nav));
    }));
    sheet.querySelectorAll<HTMLImageElement>('.strip img').forEach(img => img.addEventListener('click', () => { this.photoIndex = Number(img.dataset.i); this.renderSheet(); }));
  }

  private confirm(p: Plant, c: Plant['candidates'][number]) {
    this.decide(p, { status: 'confirmed', scientific: c.scientific, common: c.common, at: new Date().toISOString() });
  }

  private decide(p: Plant, d?: Decision) {
    if (d) this.decisions[p.id] = d; else delete this.decisions[p.id];
    if (this.set) this.save(this.set.garden);
    this.repaintPin(p);
    this.refreshCount();
    if (this.current === p) this.renderSheet();
  }

  // ---------------------------------------------------------------- pins
  private setPins(on: boolean) {
    this.pinsOn = on; this.pins.visible = on;
    this.hosts.toggle.textContent = on ? 'Pins on' : 'Pins off';
    this.hosts.toggle.classList.toggle('active', on); this.hosts.toggle.setAttribute('aria-pressed', String(on));
    this.hosts.invalidate();
  }

  private makePin(n: number, p: Plant): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.pinTexture(n, this.pinColor(p)), depthTest: false, transparent: true }));
    sprite.renderOrder = 999;
    sprite.scale.set(0.5, 0.5, 1);
    sprite.position.set(p.position[0], p.position[1] + 0.3, p.position[2]);
    sprite.name = `plant-pin-${p.id}`;
    sprite.userData.n = n;
    return sprite;
  }

  private pinColor(p: Plant) {
    const d = this.decisions[p.id];
    return PIN_COLORS[d?.status ?? p.confidence] ?? '#c2d7a9';
  }

  private pinTexture(n: number, color: string, selected = false) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    if (selected) { g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fillStyle = '#ffffff55'; g.fill(); }
    g.beginPath(); g.arc(64, 64, 44, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    g.lineWidth = selected ? 8 : 5; g.strokeStyle = selected ? '#ffffff' : '#111'; g.stroke();
    g.fillStyle = '#111'; g.font = '600 46px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), 64, 66);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  private repaintPin(p: Plant) {
    for (const [s, q] of this.sprites) if (q.id === p.id) {
      const m = s.material as THREE.SpriteMaterial; m.map?.dispose();
      m.map = this.pinTexture(s.userData.n, this.pinColor(p), this.current === p); m.needsUpdate = true;
      s.scale.setScalar(this.current === p ? 0.7 : 0.5); s.scale.z = 1;
    }
    this.hosts.invalidate();
  }

  private refreshCount() {
    if (!this.set) return;
    const total = this.order.length;
    const ds = this.order.map(p => this.decisions[p.id]).filter(Boolean);
    const done = ds.filter(d => d.status !== 'rejected').length;
    const rejected = ds.length - done;
    this.hosts.count.textContent = `${done} of ${total} confirmed${rejected ? ` · ${rejected} rejected` : ''}`;
    this.hosts.reviewButton.textContent = ds.length >= total ? 'Review again' : ds.length ? `Continue review (${total - ds.length} left)` : `Review ${total} plants`;
  }

  // ---------------------------------------------------------------- storage
  private storageKey(garden: string) { return `garden-plants:${garden}:v2`; }
  private load(garden: string): Record<string, Decision> {
    try { return JSON.parse(localStorage.getItem(this.storageKey(garden)) ?? '{}'); } catch { return {}; }
  }
  private save(garden: string) {
    try { localStorage.setItem(this.storageKey(garden), JSON.stringify(this.decisions)); } catch { /* private mode: decisions live for this page only */ }
  }
  private export() {
    if (!this.set) return;
    const out = {
      garden: this.set.garden, exportedAt: new Date().toISOString(), note: this.set.note,
      plants: this.order.map(p => ({ ...p, decision: this.decisions[p.id] ?? null })),
    };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${this.set.garden}-plants.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
