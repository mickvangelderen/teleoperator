import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Euler, Group, Matrix4, MeshBasicMaterial, Quaternion, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { alignTouchPlusToGrip } from "../src/spatial";

test("Touch Plus geometry follows Meta's Unity placement through OpenXR grip poses", async () => {
  // Independent reference chain: FBX → Unity model → Unity grip → OpenXR grip.
  // Use the SDK's published, rounded quaternion; agreement should be within 1 µm.
  const sdkOffset = new Matrix4().compose(new Vector3(0, -0.03, -0.04), new Quaternion(-0.5, 0, 0, 0.86603).normalize(), new Vector3(1, 1, 1));
  const reference = new Matrix4().makeScale(1, 1, -1).multiply(sdkOffset.invert()).multiply(new Matrix4().makeScale(-1, 1, 1));
  const loader = new GLTFLoader().register(() => ({ name: "geometry_only", loadMaterial: () => Promise.resolve(new MeshBasicMaterial()) }));
  for (const hand of ["left", "right"]) {
    const bytes = await readFile(new URL(`../public/assets/meta/controller_${hand}.glb`, import.meta.url));
    const { scene } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    const grip = new Group();
    grip.add(scene);
    const meshes: SkinnedMesh[] = [];
    scene.traverse(node => { if (node instanceof SkinnedMesh) meshes.push(node); });
    assert.ok(meshes.length > 0);
    const vertices = () => {
      grip.updateMatrixWorld(true);
      return meshes.flatMap(mesh => {
        mesh.skeleton.update();
        return Array.from({ length: mesh.geometry.attributes.position.count }, (_, i) => mesh.getVertexPosition(i, new Vector3()).applyMatrix4(mesh.matrixWorld));
      });
    };
    const authored = vertices();
    alignTouchPlusToGrip(scene);
    for (const angles of [[0, 0, 0], [0.4, -0.8, 1.2], [-1.1, 0.7, -0.3]]) {
      grip.position.set(0.2, 1.3, -0.5);
      grip.quaternion.setFromEuler(new Euler(...angles));
      const actual = vertices();
      const expected = grip.matrixWorld.clone().multiply(reference);
      actual.forEach((point, i) => assert.ok(point.distanceTo(authored[i].clone().applyMatrix4(expected)) < 1e-6, `${hand} vertex ${i} must follow the SDK frame conversion`));
    }
    const first = vertices();
    alignTouchPlusToGrip(scene);
    vertices().forEach((point, i) => assert.ok(point.distanceTo(first[i]) < 1e-12, "Alignment must not accumulate or rescale the authored geometry"));
  }
});
