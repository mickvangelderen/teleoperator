import { Bone, Matrix4, Quaternion, SkinnedMesh, Vector3 } from "three";
import type { Object3D } from "three";

// Renderer inputs contain geometry and runtime validity, without wire metadata.
export type Pose = { position: number[]; orientation: number[]; flags: number; active: boolean | null };
export type PoseFrame = { poses: Pose[]; active?: boolean };
export type Skeleton = { joints: { id: number; parent: number; rest: Pose }[] };

// A joint's rest orientation relates the runtime's axes to the asset's bind axes.
export function jointRotation(sample: number[], rest: number[], bind: Quaternion) {
  return new Quaternion().fromArray(sample).multiply(new Quaternion().fromArray(rest).invert()).multiply(bind);
}

export class BodyModel {
  private bones: { bone: Bone; id?: number; bind: Matrix4; rotation: Quaternion; scale: Vector3; child?: number; direction?: Vector3 }[] = [];
  private meshes: SkinnedMesh[] = [];

  constructor(readonly root: Object3D) {
    root.updateMatrixWorld(true);
    const byId = new Map<number, Bone>();
    root.traverse(object => { if (object instanceof Bone) byId.set(object.userData.xrJoint, object); });
    root.traverse(object => {
      if (object instanceof Bone) {
        const rotation = new Quaternion(), scale = new Vector3();
        object.matrixWorld.decompose(new Vector3(), rotation, scale);
        const child = byId.get(object.userData.xrChild);
        const direction = child?.getWorldPosition(new Vector3()).sub(object.getWorldPosition(new Vector3())).normalize();
        this.bones.push({ bone: object, id: object.userData.xrJoint, bind: object.matrix.clone(), rotation, scale, child: child?.userData.xrJoint, direction });
        object.matrixAutoUpdate = false;
      }
      if (object instanceof SkinnedMesh) {
        object.frustumCulled = false;
        this.meshes.push(object);
      }
    });
  }

  update(sample: PoseFrame | null, skeleton?: Skeleton) {
    this.root.visible = !!sample?.active && !!skeleton;
    if (!this.root.visible || !sample || !skeleton) return;
    const index = new Map(skeleton.joints.map((j, i) => [j.id, i]));
    this.root.updateWorldMatrix(true, false);
    for (const { bone, id, bind, rotation, scale, child, direction } of this.bones) {
      bone.matrix.copy(bind);
      const i = id === undefined ? undefined : index.get(id);
      if (i !== undefined && (sample.poses[i].flags & 3) === 3) {
        const pose = sample.poses[i];
        // Meta's mesh is authored in an A-pose. Align its bone direction to the
        // received T-pose before applying the runtime's orientation delta.
        let restRotation = rotation;
        const childIndex = child === undefined ? undefined : index.get(child);
        if (direction && childIndex !== undefined) {
          const target = new Vector3().fromArray(skeleton.joints[childIndex].rest.position).sub(new Vector3().fromArray(skeleton.joints[i].rest.position));
          if (target.lengthSq() > 1e-10) restRotation = new Quaternion().setFromUnitVectors(direction, target.normalize()).multiply(rotation);
        }
        const world = new Matrix4().compose(new Vector3().fromArray(pose.position), jointRotation(pose.orientation, skeleton.joints[i].rest.orientation, restRotation), scale);
        bone.parent!.updateWorldMatrix(true, false);
        bone.matrix.copy(bone.parent!.matrixWorld).invert().multiply(world);
      }
      bone.matrixWorldNeedsUpdate = true;
      bone.updateWorldMatrix(false, false);
    }
    for (const mesh of this.meshes) {
      mesh.visible = (mesh.userData.xrJoints as number[]).every(id => {
        const i = index.get(id);
        return i !== undefined && (sample.poses[i].flags & 3) === 3;
      });
    }
    this.root.updateMatrixWorld(true);
  }
}
