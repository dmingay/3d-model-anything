# 3D Model Anything — garden fork

> This is [dmingay's fork](https://github.com/dmingay/3d-model-anything) of
> [wesbos/3d-model-anything](https://github.com/wesbos/3d-model-anything), working towards a
> **garden** version: LiDAR + photo scans of beds and borders, plant identification against the
> RHS-grounded GardenLens plant database, and site layers (sun hours from the scan geometry, soil,
> elevation, climate). Work happens on the `garden` branch. First step shipped: an **Outdoor scan
> (garden)** mode in the iPhone app that drops RoomPlan and records GPS + compass orientation in
> the export (see [the app README](apps/house-capture/README.md#outdoor-garden-scans)).
>
> Garden tooling so far (all keyless, offline-testable):
> - `packages/garden-sun/` — solar position (NOAA) and a shadow-map **sun-hours** engine; the viewer
>   gets a **Sun** panel for any room with a `sun` site (try `?room=garden-synthetic&sun=1`).
>   `npm test` checks the solar maths against solstice/equinox geometry.
> - `demos/garden-synthetic/` — a made-up south-facing garden for exercising the sun map.
> - `tools/garden/site_lookup.py` — elevation, BGS soil parent material, geology, and ten years of
>   ERA5 frost/rain/temperature for a postcode, coordinates or an outdoor scan's manifest.
>   Output goes in git-ignored `data/site/`.
> - `tools/garden/garden_bundle.py` — converts an **outdoor** capture bundle (no RoomPlan walls)
>   into a garden demo: cleans the LiDAR mesh, fits the ground plane, rotates the scene so −Z is
>   true north, writes `data/web-assets/gardens/<id>/scan.glb` + upright posed photos and
>   `data/demos/<id>/garden.json` (site rounded to ~1 km). Needs the Python 3.12 venv:
>   `uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python numpy open3d pillow requests`
>   (Open3D also wants `brew install libusb`).
> - `tools/garden/plant_id.py` — Pl@ntNet (key in the git-ignored `.env` as `PLANTNET_API_KEY`)
>   on the scan's posed photos, each candidate resolved against the GardenLens RHS plant DB,
>   pinned in 3D where the photo's central ray meets the mesh → `data/demos/<id>/plants.json`.
>   The viewer's **Plants** panel shows every ID as a proposal to confirm, override or reject;
>   decisions persist in the browser and export as JSON. Raw API answers are cached under
>   `data/captures-in/<id>/plantnet/` so re-runs cost no quota.
> - `demos/front-garden/` — the first real garden (Stony Ridge front garden, scanned 19 Nov 2026).
>   The mesh and photos are local only (git-ignored); regenerate with the two tools above.
>
> Everything below is the upstream project's documentation and still applies.


[![Watch the video: 3D Model Anything](docs/images/thumb-1.png)](https://www.youtube.com/watch?v=JGQCcCzuS88)

Capture a room on an iPhone, then use its geometry and photographs to build an editable Three.js scene with an AI coding agent.

[Open the office viewer](https://wesbos.github.io/3d-model-anything/) · [App support](https://wesbos.github.io/3d-model-anything/support.html)

This repository includes the **3D Model Anything iPhone app**, a **Three.js viewer**, the **scan-to-threejs agent skill**, and **Wes’s detailed office demo**.

The app records the evidence. The skill guides an agent through measurement, modeling and matched-camera visual comparisons. This is an iterative reconstruction workflow, not a one-click scan-to-perfect-model converter. The current workflow focuses on rooms and interiors.

## Run the viewer

Use Node.js 22.12+ (or a newer supported release).

```sh
npm ci
npm run dev
```

Open http://localhost:5188. Explore the office in dollhouse, walking, overhead, wireframe and knolling views. The playground is at `/play.html?room=office-v4&mode=fpv`.

```sh
npm run build
npm run preview
```

The demo includes the reconstructed office and selected textures. Original scans and photo collections are not distributed; Scan and Overlay are disabled for this example. Those modes remain available for your own rooms with reference assets.

## Capture your own space

See [the iPhone app](apps/house-capture/README.md) for building with Xcode, device requirements, scanning and sharing. Scanning needs a LiDAR-equipped iPhone or iPad. Non-LiDAR devices can import and review scans.

The app is source-available here; an App Store release is a separate distribution step. Do not assume an App Store download is available yet.

Export a room or session through the system share sheet and extract it into an ignored `data/captures-in/<room>/` directory. Exports keep the existing `house-capture/5` contract; changing the app name does not change the files.

## Use the skill

The skill lives at `.agents/skills/scan-to-threejs/SKILL.md`. Open this repository in an agent that supports local skills and ask it to use **scan-to-threejs** with your extracted export. You can also copy that skill directory into your agent's skill directory; the companion viewer/runtime in this repo is still needed for its capture workflow.

Example request:

> Use scan-to-threejs to rebuild the room in data/captures-in/my-room. Inspect the measurements and photos, create an editable scene, and compare rendered views with the original photographs.

Start with [the format guide](.agents/skills/scan-to-threejs/references/house-capture.md) and [project layout](.agents/skills/scan-to-threejs/references/project-layout.md). Helpers need Python 3; photo comparisons need Pillow, and optional depth reconstruction needs NumPy, Open3D and Pillow. Capture scripts use the `agent-browser` CLI.

A new room goes in `demos/<id>/` and is registered in `demos/index.ts`. The office example retains its earlier reconstruction layers (`office-v2`, `office-latest`, `office-v4`) to preserve the final geometry.

## Privacy and licensing

Only the office example is distributed. No other rooms, connected-house layout, original scan bundles, or development Git history are included. Keep your captures private; inspect assets before publishing your own demo.

Reusable source code and the skill are MIT licensed. The supplied office images/textures have separate [asset terms](ASSETS-LICENSE.md). Third-party marks, artwork and depicted products are not licensed by the code license.

See [release status](docs/release-status.md) for validation and iPhone distribution steps.
