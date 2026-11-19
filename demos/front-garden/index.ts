import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import garden from '../../data/demos/front-garden/garden.json';
import plants from '../../data/demos/front-garden/plants.json';
import type { RoomModule, PlantSet } from '../../packages/room-runtime/types';

/**
 * Real garden scanned with the outdoor capture mode (19 Nov 2026): the LiDAR mesh in the garden
 * frame produced by tools/garden/garden_bundle.py (+Y up, ground y=0, −Z true north). The mesh
 * itself is both the sun receiver and the occluder, so every surface the phone saw gets a
 * sun-hours value. The GLB and photos are local only (git-ignored); regenerate from the bundle.
 */
export const frontGarden: RoomModule = {
  id: 'front-garden', label: 'Front garden · 19 Nov scan',
  async build() {
    const group = new THREE.Group();
    group.name = 'front-garden';

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}${garden.mesh.file}`);
    const scan = new THREE.Group(); scan.name = 'scan';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    const receivers: THREE.Mesh[] = [];
    gltf.scene.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = o.geometry as THREE.BufferGeometry;
      if (!g.getAttribute('color')) {
        const n = g.getAttribute('position').count;
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.55), 3));
      }
      // Open3D writes sRGB bytes; three reads glTF COLOR_0 as linear, so correct once here.
      const c = g.getAttribute('color');
      const col = new THREE.Color();
      for (let i = 0; i < c.count; i++) { col.setRGB(c.getX(i), c.getY(i), c.getZ(i), THREE.SRGBColorSpace); c.setXYZ(i, col.r, col.g, col.b); }
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      const m = new THREE.Mesh(g, material);
      m.name = 'scan-mesh'; m.castShadow = true; m.receiveShadow = true;
      scan.add(m); receivers.push(m);
    });
    group.add(scan);

    // A flat pad at ground level under the scan: fills LiDAR holes in the lawn for the sun map
    // and gives the walker something to stand on. Slightly below y=0 so the real ground wins.
    const [bx0, , bz0] = garden.bounds.p1; const [bx1, , bz1] = garden.bounds.p99;
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(bx1 - bx0 + 2, bz1 - bz0 + 2, 64, 64),
      new THREE.MeshStandardMaterial({ color: '#6f7a58', roughness: 1 }));
    pad.rotation.x = -Math.PI / 2; pad.position.set((bx0 + bx1) / 2, -0.04, (bz0 + bz1) / 2);
    pad.name = 'ground-pad'; pad.receiveShadow = true;
    group.add(pad); receivers.push(pad);

    const lights = new THREE.Group();
    lights.add(new THREE.HemisphereLight('#cfe3ff', '#56513f', 2.0));
    const sun = new THREE.DirectionalLight('#fff3df', 3.0);
    sun.position.set(-6, 12, 9); sun.castShadow = true;        // visual key light only (SW-ish)
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005;
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 50 });
    lights.add(sun, sun.target);

    const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
    return {
      group, lights, walls: [], ceiling: [], wallTop: 99,
      exposure: 1.0,
      render: { envNeutral: true, envSize: 128, ao: { intensity: 0.5, radius: 0.5 } },
      walkable: (x, z) => x > bx0 && x < bx1 && z > bz0 && z < bz1,
      camera: { orbit: [cx - 3, 7, cz + 10], target: [cx, 0.8, cz], walk: [cx, 1.6, bz1 - 1], walkLook: [cx, 1.0, bz0] },
      environment: { center: [cx, 1.5, cz], intensity: 0.8 },
      loadReference: async () => scan.clone(),
      referenceAvailable: false, referenceKind: 'scan',
      plants: { garden: plants.garden, photoBase: 'gardens/front-garden/', note: plants.note, proposals: plants.proposals as PlantSet['proposals'] },
      sun: {
        latitude: garden.site.latitude ?? 51.31, longitude: garden.site.longitude ?? -0.58,
        northBearing: garden.site.northBearing ?? 0,
        receivers, occluders: [scan],
      },
    };
  },
};
