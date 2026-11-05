// Convert Meta's pinned Movement sample to a local upper-body glTF asset.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { Bone, BufferGeometry, Float32BufferAttribute, Group, LoadingManager, MeshStandardMaterial, Quaternion, Skeleton, SkinnedMesh, Texture, Vector3 } from "three";

const revision = "77274f138974087ba2909bab2723fc6ff851338b";
const origin = `https://raw.githubusercontent.com/oculus-samples/Unity-Movement/${revision}/Samples~/BodyTrackingSamples/Body/Models/`;
const cache = new URL("../../.artifacts/meta-assets/", import.meta.url);
await mkdir(cache, { recursive: true });
async function source(name, sha256) {
  const file = new URL(name, cache);
  let data;
  try { data = await readFile(file); } catch {
    const response = await fetch(origin + name);
    assert.ok(response.ok, `Downloading ${name}: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    await writeFile(file, data);
  }
  assert.equal(createHash("sha256").update(data).digest("hex"), sha256, `${name} checksum`);
  return data;
}
const data = await source("Realistic.fbx", "21b3ce8cccf3a50a2394e5de0937671fac0eef9ea0c74058965bdde72df356fc");
const config = await source("Realistic.json", "9b8e966c5313ed096b59917e1f3531d514926900b3b4c836a2e8b13c39a42af1");
const joints = JSON.parse(config.toString().replaceAll("\0", "")).source.joints.slice(0, 70);
assert.equal(joints.length, 70);
const manager = new LoadingManager();
manager.addHandler(/.*/, { setPath() { return this; }, load: () => new Texture() });
const original = new FBXLoader(manager).parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
original.updateMatrixWorld(true);
const normalize = name => name.replace(/_jnt$/, "").replace(/Pinky/g, "LittlePinky").replace(/Meta$/, "Metacarpal");
const originalBones = new Map();
original.traverse(object => {
  if (object.isBone) {
    const id = joints.indexOf(normalize(object.name));
    if (id >= 0 && !originalBones.has(id)) originalBones.set(id, object);
  }
});
// Bake the FBX's authored pose before merging helper/twist influences. This
// preserves its mesh while giving each wire joint one explicit global bone.
const model = new Group(); model.name = "Meta_Movement_UpperBody";
const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
const bones = [], boneIndex = new Map();
for (const [id, originalBone] of originalBones) {
  const bone = new Bone(); bone.name = joints[id]; bone.userData.xrJoint = id;
  bone.position.copy(originalBone.getWorldPosition(new Vector3())).multiplyScalar(0.01).applyQuaternion(turn);
  bone.quaternion.copy(turn).multiply(originalBone.getWorldQuaternion(new Quaternion()));
  const descendants = [];
  originalBone.traverse(child => {
    const childId = joints.indexOf(normalize(child.name));
    if (child !== originalBone && child.isBone && childId >= 0 && childId !== id) descendants.push(childId);
  });
  const preferred = id === 19 ? 30 : id === 45 ? 56 : undefined;
  bone.userData.xrChild = descendants.includes(preferred) ? preferred : descendants[0];
  boneIndex.set(id, bones.length); bones.push(bone); model.add(bone);
}
model.updateMatrixWorld(true);
const rig = new Skeleton(bones);
const hips = originalBones.get(1).getWorldPosition(new Vector3()).y * 0.01;
let triangles = 0;
original.traverse(object => {
  if (!object.isSkinnedMesh || object.name === "mouth_ply") return;
  object.normalizeSkinWeights(); object.skeleton.update();
  const geometry = object.geometry, position = geometry.attributes.position;
  const points = Array.from({ length: position.count }, (_, i) => object.getVertexPosition(i, new Vector3()).applyMatrix4(object.matrixWorld).multiplyScalar(0.01).applyQuaternion(turn));
  const positions = [], skinIndices = [], skinWeights = [], used = new Set();
  for (let i = 0; i < (geometry.index?.count ?? position.count); i += 3) {
    const face = [0, 1, 2].map(n => geometry.index ? geometry.index.getX(i + n) : i + n);
    // No legs are delivered by XR_BODY_JOINT_SET_DEFAULT_FB.
    if (!face.every(v => points[v].y >= hips)) continue;
    for (const v of face) {
      positions.push(...points[v].toArray());
      const weights = new Map();
      for (let slot = 0; slot < 4; slot++) {
        const weight = geometry.attributes.skinWeight.getComponent(v, slot);
        if (weight <= 0) continue;
        let bone = object.skeleton.bones[geometry.attributes.skinIndex.getComponent(v, slot)];
        while (bone?.isBone) {
          const id = joints.indexOf(normalize(bone.name));
          if (boneIndex.has(id)) {
            used.add(id); const index = boneIndex.get(id);
            weights.set(index, (weights.get(index) ?? 0) + weight); break;
          }
          bone = bone.parent;
        }
      }
      assert.ok(weights.size, "Every retained vertex must have a supported joint");
      const total = [...weights.values()].reduce((a, b) => a + b, 0);
      const entries = [...weights];
      for (let slot = 0; slot < 4; slot++) { skinIndices.push(entries[slot]?.[0] ?? 0); skinWeights.push((entries[slot]?.[1] ?? 0) / total); }
    }
  }
  if (!positions.length) return;
  triangles += positions.length / 9;
  const output = new BufferGeometry();
  output.setAttribute("position", new Float32BufferAttribute(positions, 3));
  output.setAttribute("skinIndex", new Float32BufferAttribute(skinIndices, 4));
  output.setAttribute("skinWeight", new Float32BufferAttribute(skinWeights, 4));
  output.computeVertexNormals();
  const material = new MeshStandardMaterial({ color: object.name.includes("wetsuit") ? 0x71978c : object.name.includes("cornea") ? 0x343c3a : 0xb8c4bd, roughness: 0.78 });
  const mesh = new SkinnedMesh(output, material); mesh.name = object.name;
  mesh.userData.xrJoints = [...used].sort((a, b) => a - b);
  model.add(mesh); mesh.bind(rig);
});
assert.ok(bones.length >= 50 && triangles > 1000, "Expected a rigged upper-body mesh");
model.userData = { source: origin + "Realistic.fbx", jointSet: "XR_BODY_JOINT_SET_DEFAULT_FB" };
// GLTFExporter uses FileReader for binary buffers even without image textures.
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
};
const glb = await new GLTFExporter().parseAsync(model, { binary: true, onlyVisible: true });
const destination = new URL("../public/assets/meta/body.glb", import.meta.url);
await writeFile(destination, Buffer.from(glb));
console.log(`Exported ${triangles} triangles, ${bones.length} mapped bones, ${glb.byteLength} bytes to ${destination.pathname}`);
