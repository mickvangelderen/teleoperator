# Viewer asset sources

These assets depict the tracked equipment and body in XR Operator. Their licenses
are separate from application code. Source URLs and SHA-256 checksums are recorded
here and in `sha256.json`. Assets are served locally; no model download occurs at
runtime. OpenArm Teleop informed the Three.js/WebGL, glTF, OrbitControls and HDR
lighting choices. No application code was copied from that project.

## Headset

- Source: [Meta Immersive Web Emulator v1.3.0](https://github.com/meta-quest/immersive-web-emulator/blob/faf6d2b7e6f6cb1848ada58c4339aa3336f1935b/src/devtool/assets/headset.glb).
- Revision: `faf6d2b7e6f6cb1848ada58c4339aa3336f1935b`.
- File: `meta/headset.glb`, unchanged. License: `meta/EMULATOR-LICENSE.txt` (MIT).
- This is Meta's simplified emulator headset, not an exact Quest 3 model.
  Authored scale is retained; the visual turns 180° around Y to face OpenXR -Z.
  The art's center is attached to the received head pose. Verify its visual origin
  against the headset; this asset does not establish an optical calibration.

## Touch Plus controllers

- Source: [Meta Quest Hardware Art 1.8](https://developers.meta.com/horizon/downloads/package/oculus-controller-art/), updated 2024-02-03.
- Original download: https://securecdn-sjc6-1.oculus.com/binaries/download/?id=6989765204455805
- Files: `meta/controller_left.glb`, `meta/controller_right.glb` and their PNG textures.
- License: `meta/ART_ATTRIBUTION_LICENSE.txt`, retained with the assets.
- Reused unchanged from OpenArm Teleop's attributed `operator/assets/meta_touch_plus`
  distribution at commit `a740d127255a228175c225b7c72c63a0f2a64682`. Those GLBs were converted from Meta's original Touch Plus FBXs;
  no converter/application code is included from OpenArm Teleop.
- Preserve the authored origin and centimetre-to-metre root scale. The visual turns
  180° around Y to face OpenXR -Z and attaches to the aim pose, following that
  project's asset convention. Grip axes remain independent. Battery indicators
  are hidden because no battery state is supplied. Buttons remain in their authored
  pose; actual button states are shown in the input cards.

## Body

- Source: [Meta Unity Movement Realistic sample](https://github.com/oculus-samples/Unity-Movement/tree/77274f138974087ba2909bab2723fc6ff851338b/Samples~/BodyTrackingSamples/Body/Models).
- Revision: `77274f138974087ba2909bab2723fc6ff851338b`.
- Original files: `Realistic.fbx` and `Realistic.json`.
- License: `meta/MOVEMENT-LICENSE.txt`, referencing the [Oculus SDK License Agreement](https://developers.meta.com/vr/licenses/oculussdk/).
- Derived file: `meta/body.glb`. Rebuild from `viewer/` using `pnpm build:body`.
  The script downloads to the ignored repository `.artifacts/meta-assets` directory
  and verifies pinned SHA-256 hashes before conversion.
- Conversion uses the pinned Three.js FBXLoader and GLTFExporter. It bakes the
  authored pose, merges helper/twist influences onto 58 mapped OpenXR joints,
  retains four normalized weights per vertex, removes facial morph animations,
  removes geometry below the hips, and applies neutral inspection materials.
  The model contains 25,261 triangles. All 70 received joints remain available in
  the independent overlay, including joints without a directly mapped mesh bone.
- Centimetres become metres and +Z art turns toward OpenXR -Z. The Viewer aligns
  bone directions to the received rest skeleton, then applies each sample's global
  position and orientation delta. This is a visualization retarget, not Meta's
  Unity retargeting runtime. No leg motion or face animation is synthesized.

## Studio lighting

- [Studio Small 09](https://polyhaven.com/a/studio_small_09) by Sergej Majboroda,
  [CC0](https://polyhaven.com/license).
- Unmodified file: `environment/studio_small_09_1k.hdr`.
- Download: https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr
- Used for prefiltered PBR lighting and reflections with a solid viewport background.
