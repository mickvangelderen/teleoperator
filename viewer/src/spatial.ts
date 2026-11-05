import type { Pose, Sample } from "./protocol";

const ns = "http://www.w3.org/2000/svg";
const project = ([x, y, z]: number[]) => [450 + (x - z) * 130, 330 + (x + z) * 56 - y * 130];
function transform(v: number[], pose: Pose) {
  const [x, y, z, w] = pose.orientation, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + y * tz - z * ty, b + w * ty + z * tx - x * tz, c + w * tz + x * ty - y * tx].map((n, i) => n + pose.position[i]);
}
export function drawPoses(svg: SVGSVGElement, sample: Sample | null, sources: string[], stale: boolean) {
  svg.replaceChildren();
  if (!sample) return;
  sample.poses.forEach((pose, i) => {
    if (!(pose.flags & 2) || pose.active === false) return;
    const [x, y] = project(pose.position);
    const color = sources[i].startsWith("left") ? "#b45f2d" : sources[i].startsWith("right") ? "#476cac" : "#286b4c";
    const g = document.createElementNS(ns, "g");
    g.setAttribute("opacity", stale ? "0.25" : pose.flags & 8 ? "1" : "0.45");
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(y)); circle.setAttribute("r", sources[i] === "head" ? "10" : "5"); circle.setAttribute("fill", color); g.append(circle);
    if (pose.flags & 1) {
      for (const [axis, tint] of [[[0.2, 0, 0], "#b65c54"], [[0, 0.2, 0], "#3b8b62"], [[0, 0, -0.35], color]] as const) {
        const [ex, ey] = project(transform([...axis], pose));
        const line = document.createElementNS(ns, "line");
        line.setAttribute("x1", String(x)); line.setAttribute("y1", String(y)); line.setAttribute("x2", String(ex)); line.setAttribute("y2", String(ey)); line.setAttribute("stroke", tint); line.setAttribute("stroke-width", "2.5"); g.append(line);
      }
    }
    const label = document.createElementNS(ns, "text"); label.setAttribute("x", String(x + 13)); label.setAttribute("y", String(y + (sources[i].endsWith("aim") ? -12 : 18))); label.setAttribute("fill", color); label.textContent = sources[i]; g.append(label);
    svg.append(g);
  });
}
