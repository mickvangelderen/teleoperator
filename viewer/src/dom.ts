export function setText(element: Element, value: string) {
  if (element.textContent === value) return;
  const child = element.firstChild;
  if (child instanceof Text && element.childNodes.length === 1) child.data = value;
  else element.textContent = value;
}

export function setAttribute(element: Element, name: string, value: string | null) {
  if (element.getAttribute(name) === value) return;
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
