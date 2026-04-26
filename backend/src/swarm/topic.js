/**
 * Geographic discovery topic derivation:
 * converts lat/lon into H3 and hashes it to a 32-byte Hyperswarm topic.
 */
import { createHash } from "node:crypto";
import { latLngToCell } from "h3-js";

export function deriveDiscoveryTopic({ lat, lon }, resolution, namespace = "") {
  const h3Cell = latLngToCell(lat, lon, resolution);
  const topicSeed = namespace ? `${namespace}:${h3Cell}` : h3Cell;
  const topicBuffer = createHash("sha256").update(topicSeed).digest();

  return {
    h3Cell,
    topicBuffer
  };
}
