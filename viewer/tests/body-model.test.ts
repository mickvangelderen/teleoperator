import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Bone, Quaternion, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BodyModel } from "../src/body-model";
import type { Pose, Sample, Skeleton } from "../src/protocol";

test("Meta body follows absolute poses on the first frame and hides invalid geometry", async () => {
  const bytes = await readFile(new URL("../public/assets/meta/body.glb", import.meta.url));
  const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  scene.updateMatrixWorld(true);
  const poses: Pose[] = Array.from({ length: 70 }, () => ({ position: [0, 0, 0], orientation: [0, 0, 0, 1], flags: 15, active: null }));
  const meshes: SkinnedMesh[] = [];
  let mapped = 0;
  scene.traverse(object => {
    if (object instanceof Bone) {
      mapped++;
      poses[object.userData.xrJoint] = { ...poses[0], position: object.getWorldPosition(new Vector3()).toArray(), orientation: object.getWorldQuaternion(new Quaternion()).toArray() };
    }
    if (object instanceof SkinnedMesh) meshes.push(object);
  });
  assert.ok(mapped >= 50 && meshes.length >= 3);
  const skeleton: Skeleton = { kind: "SkeletonDefinition", id: 2n, version: 1, reference: { id: 1n, version: 1 }, jointSet: "XR_BODY_JOINT_SET_DEFAULT_FB", joints: poses.map((rest, id) => ({ id, parent: -1, name: String(id), rest })) };
  const sample: Sample = { type: "body", number: 1n, acquiredAt: 1n, targetAt: null, referenceVersion: 1, poses, inputs: [], body: { active: true, confidence: 1, returnedAt: null, skeletonVersion: 1, fidelity: null, calibration: null } };
  const vertices = () => meshes.flatMap(mesh => {
    mesh.skeleton.update();
    return Array.from({ length: 8 }, (_, i) => mesh.getVertexPosition(i * 3, new Vector3()).applyMatrix4(mesh.matrixWorld));
  });
  const original = vertices(), model = new BodyModel(scene);
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), shift = new Vector3(0.2, 0.3, -0.1);
  const moved = { ...sample, poses: poses.map(p => ({ ...p, position: new Vector3().fromArray(p.position).applyQuaternion(turn).add(shift).toArray(), orientation: turn.clone().multiply(new Quaternion().fromArray(p.orientation)).toArray() })) };
  model.update(moved, skeleton);
  vertices().forEach((p, i) => assert.ok(p.distanceTo(original[i].clone().applyQuaternion(turn).add(shift)) < 1e-5, `vertex ${i} must follow the first received pose`));
  const first = vertices(); model.update(moved, skeleton);
  vertices().forEach((p, i) => assert.ok(p.distanceTo(first[i]) < 1e-6, "Repeating a sample must not accumulate transformations"));
  const invalid = { ...moved, poses: moved.poses.map(p => ({ ...p, flags: 0 })) };
  model.update(invalid, skeleton); assert.ok(meshes.every(mesh => !mesh.visible));
  model.update(null, skeleton); assert.equal(scene.visible, false);
});
