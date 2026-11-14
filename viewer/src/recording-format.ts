export const recordingChunkBytes = 64 * 1024 ** 2;
// A 1 MiB wire packet expands to 4/3 MiB when encoded as base64.
export const recordingBatchBytes = 2 * 1024 ** 2;

// Checkpoints contain protocol u64s; tagged decimal strings preserve their exact values.
export function stringifyRecording(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { $bigint: item.toString() } : item);
}
