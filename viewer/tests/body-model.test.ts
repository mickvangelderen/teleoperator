import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Bone, Matrix4, Quaternion, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BodyModel } from "../src/body-model";
import type { Pose, PoseFrame, Skeleton } from "../src/body-model";
import { Session } from "../src/session";
import { NON_MAX, timing } from "../src/protocol";
import type { Capabilities } from "../src/protocol";
import { spatialFrames } from "../src/tracking-view";

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
  const skeleton: Skeleton = { joints: poses.map((rest, id) => ({ id, parent: -1, rest })) };
  const sample: PoseFrame = { poses, active: true };
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
  model.update({ ...moved, poses: moved.poses.toReversed() }, { joints: skeleton.joints.toReversed() });
  vertices().forEach((p, i) => assert.ok(p.distanceTo(first[i]) < 1e-6, "Joint identities, not array order, drive skinning"));
  const restTurn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
  const calibrated = { joints: skeleton.joints.map(j => ({ ...j, rest: { ...j.rest, orientation: restTurn.toArray() } })) };
  model.update({ ...moved, poses: moved.poses.map(p => ({ ...p, orientation: turn.clone().multiply(restTurn).toArray() })) }, calibrated);
  vertices().forEach((p, i) => assert.ok(p.distanceTo(first[i]) < 1e-5, "Runtime rest axes are removed before applying bind axes"));

  // Invalid/missing inputs must not leave the previous skin or bind pose visible.
  for (const flags of [0, 1, 2]) {
    model.update({ ...moved, poses: moved.poses.map(p => ({ ...p, flags })) }, skeleton);
    assert.equal(scene.visible, false);
  }
  model.update({ ...moved, poses: [] }, skeleton); assert.equal(scene.visible, false);
  model.update({ ...moved, poses: moved.poses.map(p => ({ ...p, active: false })) }, skeleton); assert.equal(scene.visible, false);
  model.update(moved, { joints: skeleton.joints.map(j => ({ ...j, rest: { ...j.rest, flags: 0 } })) });
  assert.equal(scene.visible, false, "Missing rest calibration must hide skin even with valid live poses");
  model.update(moved, skeleton); assert.ok(meshes.every(mesh => mesh.visible));

  const arm = meshes[0].skeleton.bones.find(b => b.userData.xrJoint === 10)!;
  const childId = arm.userData.xrChild;
  const beforeDirection = new Vector3().fromArray(poses[childId].position).sub(new Vector3().fromArray(poses[10].position)).normalize();
  const localDirection = beforeDirection.applyQuaternion(new Quaternion().fromArray(poses[10].orientation).invert());
  const tPose = { joints: skeleton.joints.map(j => ({ ...j, rest: { ...j.rest } })) };
  tPose.joints[childId].rest.position = new Vector3().fromArray(poses[10].position).add(new Vector3(-0.2, 0, 0)).toArray();
  model.update({ active: true, poses: tPose.joints.map(j => j.rest) }, tPose);
  assert.ok(localDirection.applyQuaternion(arm.getWorldQuaternion(new Quaternion())).distanceTo(new Vector3(-1, 0, 0)) < 1e-5, "A-pose bind bones align to the advertised T-pose");
  tPose.joints[childId].rest.flags = 0;
  model.update(sample, tPose);
  assert.ok(meshes.filter(m => m.userData.xrJoints.includes(10)).every(m => !m.visible), "Invalid direction calibration hides affected surfaces");
  const invalid = { ...moved, poses: moved.poses.map(p => ({ ...p, flags: 0 })) };
  model.update(invalid, skeleton); assert.ok(meshes.every(mesh => !mesh.visible));
  model.update(null, skeleton); assert.equal(scene.visible, false);
});

test("archived Quest rest axes survive parent-space publication, reconstruction and skinning", async () => {
  // Native SkeletonDefinition captured 2026-11-05; provenance is in the fixture.
  // This exercises real rest geometry offline, not a new hardware observation.
  const captured: Skeleton = JSON.parse(await readFile(new URL("./fixtures/quest-body-rest.json", import.meta.url), "utf8"));
  assert.deepEqual(captured.joints[0].rest.orientation, [0, 0, 0, 1]);
  assert.equal(captured.joints.filter(j => j.rest.orientation.slice(0, 3).some(v => Math.abs(v) > 1e-5)).length, 69);
  const native: Skeleton = { joints: captured.joints.map(j => ({ ...j, rest: { ...j.rest, orientation: new Quaternion().fromArray(j.rest.orientation).normalize().toArray() } })) };
  const transform = (p: Pose) => new Matrix4().compose(new Vector3().fromArray(p.position), new Quaternion().fromArray(p.orientation), new Vector3(1, 1, 1));
  const parentPoses = native.joints.map(j => {
    if (j.parent < 0) return [0, 0, 0, 0, 0, 0, 1];
    const relative = transform(native.joints[j.parent].rest).invert().multiply(transform(j.rest));
    const p = new Vector3(), q = new Quaternion(); relative.decompose(p, q, new Vector3());
    return [...p.toArray(), ...q.normalize().toArray()];
  });
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7), shift = new Vector3(0.3, 0.8, -0.2);
  const moved: PoseFrame = { active: true, poses: native.joints.map(({ rest }) => ({ ...rest,
    position: new Vector3().fromArray(rest.position).applyQuaternion(turn).add(shift).toArray(),
    orientation: turn.clone().multiply(new Quaternion().fromArray(rest.orientation)).toArray(),
  })) };
  const c: Capabilities = { groups: [60, 60], descriptors: native.joints.flatMap(j => [
    { id: `/body/FB/${j.id}`, name: "Live", description: "", kind: 10, formats: [10], spaces: [4], group: 0 },
    { id: `/body/FB/${j.id}/rest`, name: "Rest", description: "", kind: 10, formats: [10], spaces: [5], group: 1 },
  ]), skeletons: [{ joints: native.joints.map((j, i) => ({ parent: j.parent < 0 ? i : j.parent, pose_sample: i * 2, rest_pose_sample: i * 2 + 1 })) }] };
  for (const group of [0, 1]) c.descriptors.push({ id: `revision/${group}`, name: "Revision", description: "", kind: 11, formats: [4], spaces: [], group, revision_of: 1 });
  const session = new Session(); session.receive({ tag: 2, version: 1 }); session.receive({ tag: 3, capabilities: c });
  for (const group of [0, 1]) {
    const selections = c.descriptors.flatMap((d, descriptor) => d.group === group ? [{ descriptor, format: d.formats[0], space: d.spaces[0] ?? 0 }] : []);
    session.request({ id: group, group, delivery: 2, ...timing(60), sequenceNumberFormat: group ? 2 : null, bundles: group ? [[], selections] : [selections] });
    session.receive({ tag: 5, id: group });
    const header = Buffer.alloc(group ? 25 : 20); header.writeUInt32LE(group); header.writeBigUInt64LE(BigInt(101 - group), 4); header.writeBigUInt64LE(NON_MAX, 12);
    if (group) header[24] = 1;
    const values = group ? parentPoses : moved.poses.map(p => [...p.position, ...p.orientation]);
    const payload = values.map(p => { const b = Buffer.alloc(28); p.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; });
    const revision = Buffer.alloc(4); revision.writeUInt32LE(89);
    assert.ok(session.tracking(Buffer.concat([header, ...payload, revision]), 10, 2));
  }
  const frame = spatialFrames(session, 11).bodyMesh!;
  assert.ok(frame);
  frame.skeleton.joints.forEach((j, i) => {
    assert.ok(new Vector3().fromArray(j.rest.position).distanceTo(new Vector3().fromArray(native.joints[i].rest.position)) < 1e-6, `rest position ${i}`);
    assert.ok(new Quaternion().fromArray(j.rest.orientation).normalize().angleTo(new Quaternion().fromArray(native.joints[i].rest.orientation)) < 1e-6, `rest axes ${i}`);
  });
  const bytes = await readFile(new URL("../public/assets/meta/body.glb", import.meta.url));
  const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  const model = new BodyModel(scene), meshes: SkinnedMesh[] = [];
  scene.traverse(o => { if (o instanceof SkinnedMesh) meshes.push(o); });
  const vertices = () => meshes.flatMap(mesh => {
    mesh.skeleton.update();
    return Array.from({ length: 16 }, (_, i) => mesh.getVertexPosition(i * 3, new Vector3()).applyMatrix4(mesh.matrixWorld));
  });
  model.update(moved, native); const expected = vertices();
  model.update(frame.sample, frame.skeleton);
  assert.ok(meshes.every(mesh => mesh.visible));
  vertices().forEach((p, i) => assert.ok(p.distanceTo(expected[i]) < 2e-5, `live vertex ${i} retains native calibration`));
  model.update({ active: true, poses: native.joints.map(j => j.rest) }, native); const restExpected = vertices();
  const rest = spatialFrames(session, 11, true).bodyMesh!;
  model.update(rest.sample, rest.skeleton);
  vertices().forEach((p, i) => assert.ok(p.distanceTo(restExpected[i]) < 2e-5, `rest vertex ${i} retains native calibration`));
});
