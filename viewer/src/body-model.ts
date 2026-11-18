import { Bone, Matrix4, Quaternion, SkinnedMesh, Vector3 } from "three";
import type { Object3D } from "three";

// Renderer inputs contain geometry and runtime validity, without wire metadata.
export type Pose = { position: number[]; orientation: number[]; flags: number; active: boolean | null; tracked?: boolean };
export type PoseFrame = { poses: Pose[]; active?: boolean };
export type JointHierarchy = { joints: { id: number; parent: number }[] };
export type Skeleton = { joints: { id: number; parent: number; rest: Pose }[] };
export type BodyMeshFrame = { sample: PoseFrame; skeleton: Skeleton };

const valid = (pose: Pose | undefined): pose is Pose => !!pose && pose.active !== false && (pose.flags & 3) === 3;

export class BodyModel {
  private bones: { bone: Bone; id?: number; bind: Matrix4; rotation: Quaternion; scale: Vector3; child?: number; direction?: Vector3 }[] = [];
  private meshes: SkinnedMesh[] = [];
  private children = new Map<number, number>();
  private ids: number[] = [];
  private index = new Map<number, number>();
  private position = new Vector3();
  private target = new Vector3();
  private restRotation = new Quaternion();
  private orientation = new Quaternion();
  private inverseRest = new Quaternion();
  private world = new Matrix4();

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
        if (child) this.children.set(object.userData.xrJoint, child.userData.xrJoint);
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
    // Layouts can be reordered by capability discovery. Cache only the mapping,
    // never the rest values: a new reliable rest snapshot can change calibration.
    if (this.ids.length !== skeleton.joints.length || skeleton.joints.some((j, i) => j.id !== this.ids[i])) {
      this.ids = skeleton.joints.map(j => j.id);
      this.index = new Map(this.ids.map((id, i) => [id, i]));
    }
    const index = this.index;
    this.root.updateWorldMatrix(true, false);
    for (const { bone, id, bind, rotation, scale, child, direction } of this.bones) {
      bone.matrix.copy(bind);
      const i = id === undefined ? undefined : index.get(id);
      if (i !== undefined && valid(sample.poses[i]) && valid(skeleton.joints[i].rest)) {
        const pose = sample.poses[i];
        // Meta's mesh is authored in an A-pose. Align its bone direction to the
        // received T-pose before applying the runtime's orientation delta.
        this.restRotation.copy(rotation);
        const childIndex = child === undefined ? undefined : index.get(child);
        if (direction && childIndex !== undefined) {
          const target = this.target.fromArray(skeleton.joints[childIndex].rest.position).sub(this.position.fromArray(skeleton.joints[i].rest.position));
          if (target.lengthSq() > 1e-10) this.restRotation.setFromUnitVectors(direction, target.normalize()).multiply(rotation);
        }
        // Runtime orientation delta, followed by the asset's aligned bind axes.
        this.orientation.fromArray(pose.orientation).multiply(this.inverseRest.fromArray(skeleton.joints[i].rest.orientation).invert()).multiply(this.restRotation);
        const world = this.world.compose(this.position.fromArray(pose.position), this.orientation, scale);
        bone.parent!.updateWorldMatrix(true, false);
        bone.matrix.copy(bone.parent!.matrixWorld).invert().multiply(world);
      }
      bone.matrixWorldNeedsUpdate = true;
      bone.updateWorldMatrix(false, false);
    }
    for (const mesh of this.meshes) {
      mesh.visible = (mesh.userData.xrJoints as number[]).every(id => {
        const i = index.get(id);
        if (i === undefined || !valid(sample.poses[i]) || !valid(skeleton.joints[i].rest)) return false;
        // Direction alignment also depends on the advertised child's rest pose.
        const childId = this.children.get(id), child = childId === undefined ? undefined : index.get(childId);
        return childId === undefined || (child !== undefined && valid(skeleton.joints[child].rest));
      });
    }
    this.root.visible = this.meshes.some(mesh => mesh.visible);
    this.root.updateMatrixWorld(true);
  }
}
