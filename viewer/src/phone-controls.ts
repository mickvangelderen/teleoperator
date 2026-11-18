import type { Descriptor } from "./protocol";

const control = /^\/phone\/input\/(?:integer|trigger\/value|deadman\/click(?:\/(?:press_count|release_count))?)$/;
const legacySelection = /^\/user\/hand\/(?:left|right)\/phone\/selected$/;
const legacyClick = /^\/user\/hand\/(?:left|right)\/input\/select\/click(?:\/(?:active|press_count|release_count))?$/;

// Phone UI controls acquire on events. A legacy hand-select path alone is
// also used by other operators; the phone selection descriptor identifies it.
export function phoneControlsOnly(members: Descriptor[]) {
  return members.length > 0 && (members.every(d => control.test(d.id)) ||
    (members.some(d => legacySelection.test(d.id)) &&
     members.every(d => legacySelection.test(d.id) || legacyClick.test(d.id))));
}
