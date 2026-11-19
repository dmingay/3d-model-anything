#!/usr/bin/env python3
"""Propose plant identities for a scanned garden's posed photos.

usage: .venv/bin/python tools/garden/plant_id.py <garden-id> [--every 3] [--limit N] [--no-api]

For each selected photo of data/web-assets/gardens/<id>/photos/ this
  1. asks Pl@ntNet (key in .env as PLANTNET_API_KEY; raw answers cached in
     data/captures-in/<id>/plantnet/NNNN.json so re-runs cost no quota),
  2. resolves each candidate's scientific name against the GardenLens RHS plant DB
     (~/gardenlens-backend plantdb resolver) for hardiness / soil / aspect / problems,
  3. drops a 3D pin where the photo's central ray meets the scan mesh,
and writes data/demos/<id>/plants.json: a list of *proposals*. Nothing here is a
verdict — the viewer's Plants panel asks the gardener to confirm, pick another
candidate, type a name, or reject. Confidence bands: likely ≥ 0.5, unsure 0.2–0.5,
guess < 0.2 (Pl@ntNet top score on a wide bed photo; close-ups score far higher).
"""
import argparse, glob, json, os, subprocess, sys, time
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GARDENLENS = os.path.expanduser('~/gardenlens-backend')
API = 'https://my-api.plantnet.org/v2/identify/all'


def load_env():
    p = os.path.join(REPO, '.env')
    if os.path.exists(p):
        for line in open(p):
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.strip().split('=', 1)
                os.environ.setdefault(k, v.strip().strip('"'))


def identify(photo_path, cache_path, key, crop=0.0):
    """Pl@ntNet answer for a photo, or for its centre crop (fraction of each side kept)."""
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return json.load(open(cache_path))
    import io, requests
    from PIL import Image
    if crop:
        with Image.open(photo_path) as im:
            w, h = im.size
            cw, ch = int(w * crop), int(h * crop)
            buf = io.BytesIO()
            im.crop(((w - cw) // 2, (h - ch) // 2, (w + cw) // 2, (h + ch) // 2)).save(buf, 'JPEG', quality=90)
            payload = buf.getvalue()
    else:
        payload = open(photo_path, 'rb').read()
    r = requests.post(API, params={'api-key': key, 'nb-results': 6, 'lang': 'en'},
                      files=[('images', (os.path.basename(photo_path), payload, 'image/jpeg'))],
                      data={'organs': 'auto'}, timeout=90)
    data = r.json()
    if r.status_code == 200:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        json.dump(data, open(cache_path, 'w'))
    else:
        print(f'  pl@ntnet {r.status_code}: {data.get("message")}', file=sys.stderr)
    return data


def resolve_rhs(names):
    """Resolve scientific names through the GardenLens plant DB in its own venv."""
    py = os.path.join(GARDENLENS, '.venv', 'bin', 'python')
    if not os.path.exists(py):
        print('GardenLens resolver not available; RHS facts skipped', file=sys.stderr)
        return {}
    helper = r'''
import json, sys
from plantdb.resolver import Resolver
r = Resolver(); out = {}
for q in json.load(sys.stdin):
    ms = r.resolve(q, limit=1)
    if not ms: out[q] = None; continue
    m = ms[0]
    f = {k: m.facts.get(k) for k in ("common","hardiness","soil","aspect","moisture","ph","size","pruning_group","problems","genus","species")}
    out[q] = {"botanical": m.botanical, "url": m.url, "exact": m.score == 1.0, "score": round(m.score, 3), "via": m.via_alias, "facts": f}
json.dump(out, sys.stdout)
'''
    p = subprocess.run([py, '-c', helper], input=json.dumps(sorted(set(names))), capture_output=True, text=True, cwd=GARDENLENS)
    if p.returncode != 0:
        print('resolver failed:', p.stderr[-800:], file=sys.stderr)
        return {}
    return json.loads(p.stdout)


def band(score):
    return 'likely' if score >= 0.5 else 'unsure' if score >= 0.2 else 'guess'


def group_plants(proposals, radius=1.5):
    """Merge proposals into plants: pins within `radius` m whose top candidates share a genus.

    One shrub photographed three times should be confirmed once. Greedy by score: the strongest
    proposal seeds a plant, later ones join the nearest plant that agrees on genus (any of the
    proposal's top 3 against the plant's top 3), otherwise start their own.
    """
    plants = []
    for pr in sorted(proposals, key=lambda x: -x['candidates'][0]['score']):
        genera = {c['genus'] for c in pr['candidates'][:3]}
        pos = np.array(pr['position'])
        best = None
        for pl in plants:
            d = float(np.linalg.norm(np.array(pl['_pos']) - pos))
            if d <= radius and genera & pl['_genera'] and (best is None or d < best[0]):
                best = (d, pl)
        if best:
            pl = best[1]
            pl['proposals'].append(pr['id'])
            pl['_genera'] |= genera
            n = len(pl['proposals'])
            pl['_pos'] = ((np.array(pl['_pos']) * (n - 1) + pos) / n).tolist()
        else:
            plants.append({'proposals': [pr['id']], '_pos': pos.tolist(), '_genera': set(genera)})
    by_id = {pr['id']: pr for pr in proposals}
    out = []
    for i, pl in enumerate(plants):
        merged = {}
        for pid in pl['proposals']:
            w = 2 if by_id[pid].get('closeup') else 1
            for c in by_id[pid]['candidates']:
                m = merged.setdefault(c['scientific'], {**c, 'score': 0.0, 'support': 0})
                m['score'] = max(m['score'], c['score'])
                m['support'] += w
        cands = sorted(merged.values(), key=lambda c: -(c['score'] + 0.05 * (c['support'] - 1)))[:6]
        for pid in pl['proposals']:
            by_id[pid]['plant'] = f'plant-{i + 1:02d}'
        out.append({'id': f'plant-{i + 1:02d}', 'position': [round(x, 3) for x in pl['_pos']],
                    'proposals': pl['proposals'], 'photos': [by_id[pid]['photo'] for pid in pl['proposals']],
                    'confidence': band(cands[0]['score']), 'candidates': cands, 'status': 'proposed', 'concerns': []})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('garden_id')
    ap.add_argument('--every', type=int, default=3, help='use every Nth photo')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--no-api', action='store_true', help='cached answers only')
    ap.add_argument('--crop', type=float, default=0.0, help='also try a centre crop (e.g. 0.6) and keep whichever answer scores higher')
    a = ap.parse_args()
    load_env()
    key = os.environ.get('PLANTNET_API_KEY')
    garden = json.load(open(os.path.join(REPO, 'data', 'demos', a.garden_id, 'garden.json')))
    web = os.path.join(REPO, 'data', 'web-assets', 'gardens', a.garden_id)
    cache_dir = os.path.join(REPO, 'data', 'captures-in', a.garden_id, 'plantnet')

    # scan mesh for pin placement
    import open3d as o3d
    mesh = o3d.io.read_triangle_mesh(os.path.join(REPO, 'data', 'web-assets', garden['mesh'].get('toolFile') or garden['mesh']['file']))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))

    # every Nth wide scan frame, plus every close-up / manual photo (those are the good ones)
    photos = [p for p in garden['photos'] if p['index'] % a.every == 0 or p.get('manual') or p.get('pass') == 'closeup']
    if a.limit:
        photos = photos[:a.limit]
    proposals, names, remaining = [], [], None
    for p in photos:
        cache = os.path.join(cache_dir, f"{p['index']:04d}.json")
        if a.no_api and not os.path.exists(cache):
            continue
        if not key and not os.path.exists(cache):
            print('PLANTNET_API_KEY missing and no cache for', p['file'], file=sys.stderr)
            continue
        data = identify(os.path.join(web, p['file']), cache, key)
        used = 'full'
        if a.crop and not (p.get('manual') or p.get('pass') == 'closeup'):
            ccache = cache.replace('.json', f'-c{int(a.crop * 100)}.json')
            if not (a.no_api and not os.path.exists(ccache)):
                cdata = identify(os.path.join(web, p['file']), ccache, key, crop=a.crop)
                if (cdata.get('results') or [{'score': 0}])[0]['score'] > (data.get('results') or [{'score': 0}])[0]['score']:
                    data, used = cdata, f'crop{int(a.crop * 100)}'
        results = data.get('results') or []
        if not results:
            continue
        remaining = data.get('remainingIdentificationRequests', remaining)
        pos, fwd = np.array(p['position']), np.array(p['forward'])
        ray = o3d.core.Tensor([[*pos, *fwd]], dtype=o3d.core.Dtype.Float32)
        hit = scene.cast_rays(ray)
        t = float(hit['t_hit'].numpy()[0])
        if not np.isfinite(t) or t > 6:
            t = 1.5
        point = (pos + fwd * t).round(3).tolist()
        cands = []
        for r in results[:5]:
            sp = r['species']
            cands.append({'score': round(r['score'], 3), 'scientific': sp['scientificNameWithoutAuthor'],
                          'common': (sp.get('commonNames') or [None])[0], 'genus': sp['genus']['scientificNameWithoutAuthor'],
                          'family': sp['family']['scientificNameWithoutAuthor'], 'gbif': (r.get('gbif') or {}).get('id')})
            names.append(sp['scientificNameWithoutAuthor'])
        proposals.append({'id': f"p{p['index']:04d}", 'photo': p['file'], 'photoIndex': p['index'],
                          'position': point, 'cameraPosition': p['position'], 'heading': p['heading'], 'hitDistance': round(t, 2),
                          'organs': [o.get('organ') for o in data.get('predictedOrgans', [])][:2], 'input': used,
                          'closeup': bool(p.get('manual') or p.get('pass') == 'closeup'),
                          'confidence': band(cands[0]['score']), 'candidates': cands, 'status': 'proposed', 'concerns': []})
        print(f"{p['file']}  {cands[0]['score']:.2f}  {cands[0]['scientific']}  ({band(cands[0]['score'])}, {used})")
        time.sleep(0.2)

    rhs = resolve_rhs(names)
    for pr in proposals:
        for c in pr['candidates']:
            c['rhs'] = rhs.get(c['scientific'])
    plants = group_plants(proposals)
    out = {'garden': a.garden_id, 'format': 'garden-plants/1', 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'source': {'identifier': 'Pl@ntNet v2 (project all, organs auto)', 'facts': 'RHS plant DB via GardenLens resolver'},
           'note': 'Proposals only. Confirm, override or reject in the viewer; concerns are flags to look at, never a diagnosis.',
           'remainingIdentificationRequests': remaining, 'plants': plants, 'proposals': proposals}
    path = os.path.join(REPO, 'data', 'demos', a.garden_id, 'plants.json')
    json.dump(out, open(path, 'w'), indent=1)
    by = {}
    for pr in proposals:
        by.setdefault(pr['candidates'][0]['scientific'], []).append(pr['candidates'][0]['score'])
    print(f"\n{len(proposals)} proposals grouped into {len(plants)} plants → {path}; RHS matched {sum(1 for v in rhs.values() if v)}/{len(rhs)} names")
    for k, v in sorted(by.items(), key=lambda kv: -max(kv[1])):
        print(f'  {max(v):.2f} ×{len(v)}  {k}' + (f"  → RHS {rhs[k]['botanical']} {rhs[k]['facts'].get('hardiness') or ''}" if rhs.get(k) else '  (no RHS page)'))


if __name__ == '__main__':
    main()
