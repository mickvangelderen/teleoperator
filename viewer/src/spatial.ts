import type { Pose, Sample, Skeleton } from "./protocol";

const ns = "http://www.w3.org/2000/svg";
let yaw = Math.PI / 6;
let scale = 190;
export function setView(view: string, zoom: number) {
  yaw = view === "front" ? 0 : view === "side" ? Math.PI / 2 : Math.PI / 6;
  scale = 190 * zoom;
}
const project = ([x, y, z]: number[]) => {
  const horizontal = x * Math.cos(yaw) - z * Math.sin(yaw);
  const depth = x * Math.sin(yaw) + z * Math.cos(yaw);
  return [450 + horizontal * scale, 380 - y * scale + depth * scale * 0.3];
};
function transform(v: number[], pose: Pose) {
  const [x, y, z, w] = pose.orientation, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + y * tz - z * ty, b + w * ty + z * tx - x * tz, c + w * tz + x * ty - y * tx].map((n, i) => n + pose.position[i]);
}
function line(parent: SVGElement, a: number[], b: number[], color: string, width = 1.5) {
  const [x, y] = project(a), [ex, ey] = project(b);
  const element = document.createElementNS(ns, "line");
  for (const [key, value] of Object.entries({x1: x, y1: y, x2: ex, y2: ey, stroke: color, "stroke-width": width})) element.setAttribute(key, String(value));
  parent.append(element);
}
function marker(parent: SVGElement, position: number[], color: string, radius: number) {
  const [x, y] = project(position), circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(y)); circle.setAttribute("r", String(radius)); circle.setAttribute("fill", color); parent.append(circle);
}
export function drawPoses(svg: SVGSVGElement, sample: Sample | null, sources: string[], stale: boolean, body: Sample | null = null, skeleton?: Skeleton, bodyStale = false) {
  svg.replaceChildren();
  const grid = document.createElementNS(ns, "g"); grid.setAttribute("opacity", "0.35");
  for (let i = -8; i <= 8; i++) { line(grid, [i / 4, 0, -2], [i / 4, 0, 2], "#b8c8bd", 0.7); line(grid, [-2, 0, i / 4], [2, 0, i / 4], "#b8c8bd", 0.7); }
  svg.append(grid);
  line(svg, [0, 0, 0], [0.5, 0, 0], "#b65c54"); line(svg, [0, 0, 0], [0, 0.5, 0], "#3b8b62"); line(svg, [0, 0, 0], [0, 0, -0.5], "#476cac");
  if (body?.body?.active && skeleton) {
    const g = document.createElementNS(ns, "g"); g.setAttribute("data-body", "true"); g.setAttribute("opacity", bodyStale ? "0.2" : "0.7");
    const indices = new Map(skeleton.joints.map((joint, i) => [joint.id, i]));
    skeleton.joints.forEach((joint, i) => {
      const pose = body.poses[i]; if (!(pose.flags & 2)) return;
      const parent = indices.get(joint.parent), color = i < 18 ? "#567d70" : "#829d92";
      if (parent !== undefined && (body.poses[parent].flags & 2)) line(g, pose.position, body.poses[parent].position, color, i < 18 ? 3 : 1.2);
      marker(g, pose.position, color, i < 18 ? 3.2 : 1.6);
    });
    svg.append(g);
  }
  sample?.poses.forEach((pose, i) => {
    if (!(pose.flags & 2) || pose.active === false) return;
    const name = sources[i], aim = name.endsWith("aim"), color = name.startsWith("left") ? "#b45f2d" : name.startsWith("right") ? "#476cac" : "#286b4c";
    const g = document.createElementNS(ns, "g"); g.setAttribute("data-pose", name);
    g.setAttribute("opacity", stale ? "0.25" : pose.flags & 8 ? "1" : "0.45");
    marker(g, pose.position, color, aim ? 2 : 4);
    if (pose.flags & 1) {
      line(g, pose.position, transform([0, 0, aim ? -0.45 : -0.22], pose), color, aim ? 1.2 : 2.5);
      if (!aim) {
        const [width, height, depth] = name === "head" ? [0.1, 0.06, 0.06] : [0.025, 0.07, 0.025];
        const vertices = Array.from({length: 8}, (_, n) => transform([n & 1 ? width : -width, n & 2 ? height : -height, n & 4 ? depth : -depth], pose));
        for (let n = 0; n < 8; n++) for (const bit of [1, 2, 4]) if (!(n & bit)) line(g, vertices[n], vertices[n | bit], color, 1.7);
        line(g, pose.position, transform([0, 0.18, 0], pose), "#3b8b62", 1.5);
      }
    }
    if (!aim) {
      const [x, y] = project(pose.position), label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(x + 12)); label.setAttribute("y", String(y - 18)); label.setAttribute("fill", color); label.textContent = name; g.append(label);
    }
    svg.append(g);
  });
}
