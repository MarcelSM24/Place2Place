import { createHash } from "node:crypto";
import { latLngToCell } from "h3-js";

export function deriveDiscoveryTopic({ lat, lon }, resolution) {
  const h3Cell = latLngToCell(lat, lon, resolution);
  const topicBuffer = createHash("sha256").update(h3Cell).digest();

  return {
    h3Cell,
    topicBuffer
  };
}
