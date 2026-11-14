export function formatMeasurement(value: number | null | undefined, unit = "", precision = 2) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(precision)}${unit ? ` ${unit}` : ""}`;
}
