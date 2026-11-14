export const groupColor = (group: number) => `var(--group-${group % 6})`;
export const neutralColor = "var(--graph-neutral)";
export const referenceDash = [4, 3];

export function resolveColor(color: string, style: CSSStyleDeclaration) {
  return color.startsWith("var(") ? style.getPropertyValue(color.slice(4, -1)).trim() : color;
}
