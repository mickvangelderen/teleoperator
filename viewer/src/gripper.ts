import { CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshStandardMaterial, Shape } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Dimensions are in metres. The wrist is at the pose origin and the fingertips point down −Z.
export function addGripper(shape: Group) {
  const metal = new MeshStandardMaterial({ metalness: 0.32, roughness: 0.48 });
  const housing = new Mesh(new RoundedBoxGeometry(0.124, 0.045, 0.052, 1, 0.005), metal);
  housing.position.z = -0.026;
  const flange = new Mesh(new CylinderGeometry(0.030, 0.030, 0.016, 24), metal);
  flange.rotation.x = Math.PI / 2;
  flange.position.z = 0.008;
  const ridge = new Mesh(new RoundedBoxGeometry(0.044, 0.014, 0.039, 1, 0.004), metal);
  ridge.position.set(0, 0.026, -0.025);
  shape.add(housing, flange, ridge);

  // Side profile of a finger, from the carriage to the flat inner gripping face.
  const profile = new Shape();
  profile.moveTo(0.004, 0.051);
  profile.lineTo(0.021, 0.051);
  profile.lineTo(0.021, 0.079);
  profile.lineTo(0.012, 0.129);
  profile.lineTo(0.009, 0.139);
  profile.lineTo(0, 0.139);
  profile.lineTo(0, 0.105);
  profile.lineTo(0.004, 0.101);
  profile.closePath();
  const finger = new ExtrudeGeometry(profile, { depth: 0.020, bevelSize: 0.0015, bevelThickness: 0.0015, bevelSegments: 1 });
  finger.translate(0.0015, 0, -0.010).rotateX(-Math.PI / 2);
  const jawMaterial = new MeshStandardMaterial({ metalness: 0.18, roughness: 0.62 });
  const right = new Mesh(finger, jawMaterial), left = right.clone();
  left.scale.x = -1;
  shape.add(left, right);

  return (closure?: number) => {
    // Unknown measurements use a translucent half-open reference.
    const halfGap = 0.040 * (1 - (closure ?? 0.5));
    left.position.x = -halfGap;
    right.position.x = halfGap;
    jawMaterial.transparent = closure === undefined;
    jawMaterial.opacity = closure === undefined ? 0.4 : 1;
  };
}
