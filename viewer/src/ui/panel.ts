import "./panel.css";
export function panelHeader(title: string, ...actions: Node[]) {
  const header = document.createElement("div");
  header.className = "panel-header";
  const heading = document.createElement("h2");
  heading.textContent = title;
  header.append(heading, ...actions);
  return header;
}
