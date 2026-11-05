import {
  ACESFilmicToneMapping, AxesHelper, BufferGeometry, Color, Float32BufferAttribute,
  GridHelper, Group, HemisphereLight, Line, LineBasicMaterial, LineSegments,
  Mesh, MeshStandardMaterial, PerspectiveCamera, PMREMGenerator, Scene,
  SphereGeometry, Vector3, WebGLRenderer,
} from "three";
import type { Material, Object3D } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { BodyModel } from "./body-model";
import type { Sample, Skeleton } from "./protocol";

export class SpatialView {
  private renderer = new WebGLRenderer({ antialias: true });
  private scene = new Scene();
  private camera = new PerspectiveCamera(38, 1, 0.01, 100);
  private controls: OrbitControls;
  private observer: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private poses = new Map<string, { group: Group; shape: Group }>();
  private body?: BodyModel;
  private joints = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x244e40, transparent: true, opacity: 0.75, depthTest: false }));
  private jointPositions = new Float32BufferAttribute(new Float32Array(84 * 6), 3);
  private latest: Parameters<SpatialView["update"]> = [null, [], true, null, undefined, true];
  private environment?: ReturnType<PMREMGenerator["fromEquirectangular"]>;

  constructor(private surface: HTMLElement, private status: (message: string) => void) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.scene.background = new Color(0xf0f3ef);
    this.surface.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-label", "3D view of received headset, controller and body tracking. Drag to orbit; scroll to zoom.");
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.tabIndex = 0;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 15;
    this.controls.addEventListener("change", this.invalidate);
    this.controls.listenToKeyEvents(this.renderer.domElement);
    this.setView("iso", 1);
    this.scene.add(new GridHelper(4, 16, 0xa2b4aa, 0xd5dfd7), new AxesHelper(0.35), new HemisphereLight(0xffffff, 0x89988c, 1));
    this.joints.frustumCulled = false;
    this.joints.visible = false;
    this.joints.geometry.setAttribute("position", this.jointPositions);
    this.joints.geometry.setDrawRange(0, 0);
    this.scene.add(this.joints);
    for (const name of ["head", "left/aim", "left/grip", "right/aim", "right/grip"]) {
      const color = name.startsWith("left") ? 0xb45f2d : name.startsWith("right") ? 0x476cac : 0x286b4c;
      const group = new Group(), shape = new Group();
      const marker = new Mesh(new SphereGeometry(0.008, 8, 6), new MeshStandardMaterial({ color }));
      group.add(shape, marker);
      if (name.endsWith("aim")) shape.add(new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0, -0.35)]), new LineBasicMaterial({ color })));
      else shape.add(new AxesHelper(name === "head" ? 0.12 : 0.07));
      group.visible = false;
      this.poses.set(name, { group, shape });
      this.scene.add(group);
    }
    this.observer = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = surface;
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.invalidate();
    });
    this.observer.observe(surface);
    document.addEventListener("visibilitychange", this.invalidate);
    this.renderer.domElement.addEventListener("webglcontextlost", event => { event.preventDefault(); status("3D context lost. Reload to restore the view."); });
    void this.load();
  }

  private async load() {
    this.status("Loading Meta models…");
    const loader = new GLTFLoader();
    const loads = [
      ...([ ["headset.glb", "head"], ["controller_left.glb", "left/aim"], ["controller_right.glb", "right/aim"] ] as const).map(async ([file, name]) => {
        const { scene } = await loader.loadAsync(`/assets/meta/${file}`);
        if (this.disposed) { dispose(scene); return; }
        // Meta's hardware art faces +Z; OpenXR viewing/aim frames face -Z.
        scene.rotation.y = Math.PI;
        scene.traverse(object => { if (/batteryindicator/i.test(object.name)) object.visible = false; });
        this.poses.get(name)!.shape.add(scene);
      }),
      loader.loadAsync("/assets/meta/body.glb").then(({ scene }) => {
        if (this.disposed) { dispose(scene); return; }
        this.body = new BodyModel(scene);
        scene.visible = false;
        this.scene.add(scene);
      }),
      new HDRLoader().loadAsync("/assets/environment/studio_small_09_1k.hdr").then(hdr => {
        if (this.disposed) { hdr.dispose(); return; }
        const pmrem = new PMREMGenerator(this.renderer);
        this.environment = pmrem.fromEquirectangular(hdr);
        this.scene.environment = this.environment.texture;
        hdr.dispose(); pmrem.dispose();
      }),
    ];
    const results = await Promise.allSettled(loads);
    if (this.disposed) return;
    const failed = results.filter(r => r.status === "rejected");
    this.surface.dataset.assets = failed.length ? "error" : "ready";
    this.status(failed.length ? "3D assets could not load. Reload to retry; tracking data remains available below." : "Meta models · drag to orbit · scroll to zoom");
    this.update(...this.latest);
  }

  private invalidate = () => {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!document.hidden) this.renderer.render(this.scene, this.camera);
    });
  };

  setView(view: string, zoom: number) {
    this.controls.target.set(0, 1.3, 0);
    const direction = view === "front" ? [0, 0.15, -1] : view === "side" ? [1, 0.15, 0] : [0.8, 0.35, -1];
    this.camera.position.copy(this.controls.target).add(new Vector3(...direction).normalize().multiplyScalar(2.4 / zoom));
    this.controls.update();
    this.invalidate();
  }

  showJoints(show: boolean) { this.joints.visible = show; this.invalidate(); }

  update(sample: Sample | null, sources: string[], stale: boolean, body: Sample | null = null, skeleton?: Skeleton, bodyStale = true) {
    this.latest = [sample, sources, stale, body, skeleton, bodyStale];
    let count = 0;
    for (const [name, object] of this.poses) {
      const pose = sample?.poses[sources.indexOf(name)];
      object.group.visible = !!pose && !!(pose.flags & 2) && pose.active !== false;
      if (!pose || !object.group.visible) continue;
      count++;
      object.group.position.fromArray(pose.position);
      object.shape.visible = !!(pose.flags & 1);
      if (object.shape.visible) object.group.quaternion.fromArray(pose.orientation);
      fade(object.group, stale ? 0.25 : pose.flags & 8 ? 1 : 0.45);
    }
    this.surface.dataset.poseCount = String(count);
    this.body?.update(body, skeleton);
    if (this.body) fade(this.body.root, bodyStale ? 0.25 : 1);
    const lines: number[] = [];
    if (body?.body?.active && skeleton) {
      const ids = new Map(skeleton.joints.map((j, i) => [j.id, i]));
      skeleton.joints.forEach((joint, i) => {
        const parent = ids.get(joint.parent);
        if (parent !== undefined && (body.poses[i].flags & 2) && (body.poses[parent].flags & 2)) lines.push(...body.poses[i].position, ...body.poses[parent].position);
      });
    }
    this.surface.dataset.bodyJoints = String(body?.body?.active ? body.poses.filter(p => (p.flags & 2) !== 0).length : 0);
    this.jointPositions.array.set(lines);
    this.jointPositions.needsUpdate = true;
    this.joints.geometry.setDrawRange(0, lines.length / 3);
    this.invalidate();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect(); this.controls.dispose();
    document.removeEventListener("visibilitychange", this.invalidate);
    this.environment?.dispose(); dispose(this.scene); this.renderer.dispose();
  }
}

function materials(object: Object3D, visit: (material: Material) => void) {
  object.traverse(child => {
    const material = (child as Mesh).material;
    if (material) for (const item of Array.isArray(material) ? material : [material]) visit(item);
  });
}
function fade(object: Object3D, opacity: number) {
  materials(object, material => {
    if (material.transparent !== (opacity < 1)) material.needsUpdate = true;
    material.opacity = opacity; material.transparent = opacity < 1; material.depthWrite = opacity === 1;
  });
}
function dispose(object: Object3D) {
  object.traverse(child => (child as Mesh).geometry?.dispose());
  materials(object, material => {
    for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
    material.dispose();
  });
}
