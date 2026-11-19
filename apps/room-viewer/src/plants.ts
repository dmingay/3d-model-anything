import * as THREE from 'three';
import type { BuiltRoom, PlantProposal, PlantSet } from '../../../packages/room-runtime/types';

/**
 * Plants panel for garden scans: numbered pins where each identified photo was taken, and a
 * card per proposal. Every identity is a proposal until the gardener confirms it, picks another
 * candidate, types their own name, or rejects it. Decisions persist per garden in localStorage
 * and export as JSON alongside the proposals.
 */
interface Decision { status: 'confirmed' | 'override' | 'rejected'; scientific?: string; common?: string | null; name?: string; at: string }

interface Hosts {
  list: HTMLElement; count: HTMLElement; toggle: HTMLButtonElement; exportButton: HTMLButtonElement;
  photoBase: string;
  onFocus: (point: THREE.Vector3, from: THREE.Vector3) => void;
}

const PIN_COLORS: Record<string, string> = { likely: '#c2d7a9', unsure: '#e9c46a', guess: '#9aa39c', confirmed: '#f3e9a8', override: '#9fd3ff', rejected: '#555b57' };

export class PlantsView {
  private pins = new THREE.Group();
  private sprites = new Map<THREE.Sprite, PlantProposal>();
  private cards = new Map<string, HTMLElement>();
  private room?: BuiltRoom;
  private set?: PlantSet;
  private decisions: Record<string, Decision> = {};
  private selected?: string;
  private pinsOn = true;

  constructor(private hosts: Hosts) {
    this.pins.name = 'plant-pins';
    hosts.toggle.addEventListener('click', () => {
      this.pinsOn = !this.pinsOn; this.pins.visible = this.pinsOn;
      hosts.toggle.textContent = this.pinsOn ? 'Pins on' : 'Pins off';
      hosts.toggle.classList.toggle('active', this.pinsOn); hosts.toggle.setAttribute('aria-pressed', String(this.pinsOn));
    });
    hosts.exportButton.addEventListener('click', () => this.export());
  }

  show(room: BuiltRoom) {
    const set = room.plants;
    if (!set) return;
    this.room = room; this.set = set;
    this.decisions = this.load(set.garden);
    this.pins.clear(); this.sprites.clear(); this.cards.clear();
    this.hosts.list.replaceChildren();
    const ordered = [...set.proposals].sort((a, b) => b.candidates[0].score - a.candidates[0].score);
    ordered.forEach((p, i) => {
      const n = i + 1;
      const sprite = this.makePin(n, p);
      this.pins.add(sprite); this.sprites.set(sprite, p);
      this.hosts.list.append(this.makeCard(n, p));
    });
    this.pins.visible = this.pinsOn;
    room.group.add(this.pins);
    this.hosts.toggle.classList.toggle('active', this.pinsOn);
    this.refreshCount();
  }

  hide() {
    this.room?.group.remove(this.pins);
    this.pins.clear(); this.sprites.clear(); this.cards.clear();
    this.hosts.list.replaceChildren();
    this.room = undefined; this.set = undefined; this.selected = undefined;
  }

  /** Called from the viewer's double-click raycast: selects the pin under the cursor, if any. */
  pick(raycaster: THREE.Raycaster): boolean {
    if (!this.pins.visible || !this.sprites.size) return false;
    const hit = raycaster.intersectObjects([...this.sprites.keys()], false)[0];
    if (!hit) return false;
    const p = this.sprites.get(hit.object as THREE.Sprite);
    if (p) this.select(p, true);
    return true;
  }

  // ---------------------------------------------------------------- pins
  private makePin(n: number, p: PlantProposal): THREE.Sprite {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.pinTexture(n, this.pinColor(p)), depthTest: false, transparent: true }));
    sprite.renderOrder = 999;
    sprite.scale.set(0.36, 0.36, 1);
    sprite.position.set(p.position[0], p.position[1] + 0.25, p.position[2]);
    sprite.name = `plant-pin-${p.id}`;
    sprite.userData.n = n;
    return sprite;
  }

  private pinColor(p: PlantProposal) {
    const d = this.decisions[p.id];
    return PIN_COLORS[d?.status ?? p.confidence] ?? '#c2d7a9';
  }

  private pinTexture(n: number, color: string, selected = false) {
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const g = c.getContext('2d')!;
    g.beginPath(); g.arc(48, 48, 40, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    g.lineWidth = selected ? 10 : 5; g.strokeStyle = selected ? '#ffffff' : '#111'; g.stroke();
    g.fillStyle = '#111'; g.font = '600 40px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), 48, 50);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  private repaintPin(p: PlantProposal) {
    for (const [s, q] of this.sprites) if (q.id === p.id) {
      const m = s.material as THREE.SpriteMaterial; m.map?.dispose();
      m.map = this.pinTexture(s.userData.n, this.pinColor(p), this.selected === p.id); m.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- cards
  private makeCard(n: number, p: PlantProposal): HTMLElement {
    const card = document.createElement('article');
    card.className = 'plant-card'; card.dataset.id = p.id;
    card.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button, input')) return; this.select(p, true); });
    this.cards.set(p.id, card);
    this.renderCard(card, n, p);
    return card;
  }

  private renderCard(card: HTMLElement, n: number, p: PlantProposal) {
    const d = this.decisions[p.id];
    const top = p.candidates[0];
    const chosen = d?.status === 'confirmed' ? p.candidates.find(c => c.scientific === d.scientific) ?? top : top;
    const rhs = chosen.rhs?.facts;
    card.classList.toggle('rejected', d?.status === 'rejected');
    card.classList.toggle('selected', this.selected === p.id);
    const pct = Math.round(top.score * 100);
    const statusText = d?.status === 'confirmed' ? `Confirmed · ${d.common ?? d.scientific}`
      : d?.status === 'override' ? `Your ID · ${d.name}`
      : d?.status === 'rejected' ? 'Marked as not a plant'
      : p.confidence === 'likely' ? `Likely (${pct}%) · confirm?` : p.confidence === 'unsure' ? `Unsure (${pct}%) · which is it?` : `Guess (${pct}%) · probably needs your name`;
    const facts = rhs ? [rhs.hardiness && `Hardiness ${rhs.hardiness}`, rhs.aspect && rhs.aspect.split(';')[0], rhs.soil && `Soil ${rhs.soil}`].filter(Boolean).join(' · ') : (chosen.rhs === null ? 'No RHS page for this name' : '');
    const title = d?.status === 'override' ? d.name : (chosen.common ? `${chosen.common} <i>${chosen.scientific}</i>` : `<i>${chosen.scientific}</i>`);
    card.innerHTML = `
      <div class="thumb"><span class="pin ${d?.status ?? p.confidence}">${n}</span><img loading="lazy" alt="Photo ${p.photoIndex}" src="${this.hosts.photoBase}${this.set!.photoBase}${p.photo}"></div>
      <div>
        <div class="plant-title">${title}</div>
        <div class="plant-status ${d?.status ?? ''}">${statusText}</div>
        <div class="plant-facts">${facts}</div>
        <div class="plant-cands"></div>
        <div class="plant-actions"><input type="text" placeholder="Or type the plant…" aria-label="Your identification"><button data-act="override">Set</button><button data-act="reject" title="Not a plant, or not useful">✕</button></div>
      </div>`;
    const cands = card.querySelector('.plant-cands')!;
    for (const c of p.candidates.slice(0, 4)) {
      const b = document.createElement('button');
      b.textContent = `${c.common ?? c.scientific} ${Math.round(c.score * 100)}%`;
      b.title = `${c.scientific} (${c.family})${c.rhs ? ` · RHS: ${c.rhs.botanical}` : ''}`;
      b.classList.toggle('top', c === top);
      b.classList.toggle('chosen', d?.status === 'confirmed' && d.scientific === c.scientific);
      b.addEventListener('click', () => this.decide(p, d?.status === 'confirmed' && d.scientific === c.scientific ? undefined : { status: 'confirmed', scientific: c.scientific, common: c.common, at: new Date().toISOString() }));
      cands.append(b);
    }
    const input = card.querySelector<HTMLInputElement>('input')!;
    if (d?.status === 'override') input.value = d.name ?? '';
    const setName = () => { const name = input.value.trim(); if (name) this.decide(p, { status: 'override', name, at: new Date().toISOString() }); };
    card.querySelector('[data-act=override]')!.addEventListener('click', setName);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') setName(); });
    card.querySelector('[data-act=reject]')!.addEventListener('click', () => this.decide(p, d?.status === 'rejected' ? undefined : { status: 'rejected', at: new Date().toISOString() }));
  }

  private decide(p: PlantProposal, d?: Decision) {
    if (d) this.decisions[p.id] = d; else delete this.decisions[p.id];
    if (this.set) this.save(this.set.garden);
    const card = this.cards.get(p.id);
    if (card) this.renderCard(card, Number(card.querySelector('.pin')!.textContent), p);
    this.repaintPin(p);
    this.refreshCount();
  }

  private select(p: PlantProposal, fly: boolean) {
    const prev = this.selected ? this.set?.proposals.find(q => q.id === this.selected) : undefined;
    this.selected = p.id;
    if (prev) { this.repaintPin(prev); this.cards.get(prev.id)?.classList.remove('selected'); }
    this.repaintPin(p);
    const card = this.cards.get(p.id);
    card?.classList.add('selected'); card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (fly) {
      const point = new THREE.Vector3(...p.position);
      const from = new THREE.Vector3(...p.cameraPosition);
      from.add(from.clone().sub(point).setLength(1.2)); from.y += 0.6;   // just behind where the phone was
      this.hosts.onFocus(point, from);
    }
  }

  private refreshCount() {
    if (!this.set) return;
    const total = this.set.proposals.length;
    const done = Object.values(this.decisions).filter(d => d.status !== 'rejected').length;
    const rejected = Object.values(this.decisions).filter(d => d.status === 'rejected').length;
    this.hosts.count.textContent = `${done} of ${total} confirmed${rejected ? ` · ${rejected} rejected` : ''}`;
  }

  // ---------------------------------------------------------------- storage
  private key(garden: string) { return `garden-plants:${garden}`; }
  private load(garden: string): Record<string, Decision> {
    try { return JSON.parse(localStorage.getItem(this.key(garden)) ?? '{}'); } catch { return {}; }
  }
  private save(garden: string) {
    try { localStorage.setItem(this.key(garden), JSON.stringify(this.decisions)); } catch { /* private mode: decisions live for this page only */ }
  }
  private export() {
    if (!this.set) return;
    const out = {
      garden: this.set.garden, exportedAt: new Date().toISOString(), note: this.set.note,
      plants: this.set.proposals.map(p => ({ ...p, decision: this.decisions[p.id] ?? null })),
    };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${this.set.garden}-plants.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
