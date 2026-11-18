import * as THREE from 'three';
import type { BuiltRoom, RoomModule } from '../../packages/room-runtime/types';
import { box, cylinder, sphere } from '../../packages/room-runtime/helpers';

/**
 * A made-up south-facing back garden for exercising the garden tooling before a real scan
 * exists: house along the north edge, fences, a hedge, a shed, a tree and two raised beds on a
 * finely tessellated lawn so sun-hours colouring has vertices to paint. Frame: metres, +Y up,
 * −Z = true north, +X = east (a north-aligned outdoor session). Stony Ridge coordinates.
 */
export const gardenSynthetic: RoomModule = {
  id: 'garden-synthetic', label: 'Synthetic garden (sun test)',
  async build(): Promise<BuiltRoom> {
    const group = new THREE.Group();
    group.name = 'garden-synthetic';
    const W = 16, D = 22; // east-west × north-south, metres
    const x0 = -W / 2, x1 = W / 2, zN = -D / 2, zS = D / 2; // north edge at zN (−Z)

    const lawnMat = new THREE.MeshStandardMaterial({ color: '#6f9a4a', roughness: 1 });
    const soilMat = new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 1 });
    const brickMat = new THREE.MeshStandardMaterial({ color: '#9a6b55', roughness: .9 });
    const fenceMat = new THREE.MeshStandardMaterial({ color: '#8a7a5a', roughness: .95 });
    const hedgeMat = new THREE.MeshStandardMaterial({ color: '#3f6b35', roughness: 1 });
    const woodMat = new THREE.MeshStandardMaterial({ color: '#5a4030', roughness: .95 });
    const leafMat = new THREE.MeshStandardMaterial({ color: '#4c7f3b', roughness: 1 });
    const pavingMat = new THREE.MeshStandardMaterial({ color: '#a8a39a', roughness: .9 });

    // ground: dense plane so per-vertex sun hours read as a smooth map (12.5 cm spacing)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, D, W * 8, D * 8), lawnMat);
    ground.rotation.x = -Math.PI / 2;
    ground.name = 'lawn';
    ground.receiveShadow = true;
    group.add(ground);

    // house along the north boundary (two storeys, 7 m deep), patio in front of it
    const house = box([W + 2, 6.5, 7], [0, 3.25, zN - 3.5 + 0.01], brickMat);
    house.name = 'house'; house.castShadow = true;
    group.add(house);
    const patio = box([8, 0.04, 3.5], [-1, 0.02, zN + 1.75], pavingMat);
    patio.name = 'patio'; group.add(patio);

    // 1.8 m fences east, west and south; a 2.2 m hedge inside the east fence
    for (const [cx, cz, sx, sz, name] of [[x0, 0, 0.05, D, 'fence-west'], [x1, 0, 0.05, D, 'fence-east'], [0, zS, W, 0.05, 'fence-south']] as const) {
      const f = box([sx, 1.8, sz], [cx, 0.9, cz], fenceMat); f.name = name; f.castShadow = true; group.add(f);
    }
    const hedge = box([0.9, 2.2, D - 6], [x1 - 0.5, 1.1, 1], hedgeMat); hedge.name = 'hedge-east'; hedge.castShadow = true; group.add(hedge);

    // shed in the south-east corner
    const shed = box([2.4, 2.2, 1.8], [x1 - 2.2, 1.1, zS - 1.1], woodMat); shed.name = 'shed'; shed.castShadow = true; group.add(shed);

    // a mature tree in the south-west: trunk + three canopy blobs
    const trunk = cylinder(0.22, 3.2, [x0 + 3.5, 1.6, zS - 4], woodMat); trunk.name = 'tree-trunk'; trunk.castShadow = true; group.add(trunk);
    for (const [dx, dy, dz, r] of [[0, 4.4, 0, 2.8], [1.4, 3.6, 0.8, 1.9], [-1.2, 3.8, -1.0, 1.7]]) {
      const c = sphere(r, [x0 + 3.5 + dx, dy, zS - 4 + dz], leafMat); c.name = 'tree-canopy'; c.castShadow = true; group.add(c);
    }

    // two raised beds (sleepers) with soil tops, mid-garden
    for (const [cx, cz, name] of [[-3, 2, 'raised-bed-west'], [2, 2, 'raised-bed-east']] as const) {
      const frame = box([3, 0.45, 1.4], [cx, 0.225, cz], woodMat); frame.name = name; frame.castShadow = true; group.add(frame);
      const top = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.2, 28, 12), soilMat);
      top.rotation.x = -Math.PI / 2; top.position.set(cx, 0.46, cz); top.name = `${name}-soil`; group.add(top);
    }
    group.traverse(o => { if (o instanceof THREE.Mesh) o.receiveShadow = true; });

    // daylight: a sky hemisphere and one sun key from the south-west (visual only; sun hours are
    // computed from solar geometry, not from this light)
    const lights = new THREE.Group();
    lights.add(new THREE.HemisphereLight('#cfe3ff', '#6b6b55', 2.2));
    const sun = new THREE.DirectionalLight('#fff3df', 3.5);
    sun.position.set(-8, 14, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 50 });
    lights.add(sun, sun.target);

    const receivers = [ground, ...group.children.filter(o => o.name.endsWith('-soil')) as THREE.Mesh[]];
    return {
      group, lights, walls: [], ceiling: [], wallTop: 99,
      exposure: 1.0,
      render: { envNeutral: true, envSize: 128, ao: { intensity: 0.6, radius: 0.4 } },
      walkable: (x, z) => x > x0 + 0.3 && x < x1 - 0.3 && z > zN + 0.3 && z < zS - 0.3,
      camera: { orbit: [-9, 12, 24], target: [0, 0.5, 1], walk: [0, 1.6, zN + 2.5], walkLook: [0, 1.2, zS] },
      environment: { center: [0, 1.5, 2], intensity: 0.8 },
      loadReference: () => Promise.reject(new Error('synthetic garden has no scan')),
      referenceAvailable: false, referenceKind: 'scan',
      sun: {
        latitude: 51.309915, longitude: -0.578314, northBearing: 0,
        receivers, occluders: [group],
      },
    };
  },
};
