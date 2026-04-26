/**
 * Minimal fixed-size telemetry codec (19 bytes) used for compact peer-local event storage.
 */
import c from "compact-encoding";

export const TELEMETRY_PAYLOAD_BYTES = 19;

const telemetry19Encoding = {
  preencode(state) {
    c.uint64.preencode(state);
    c.uint64.preencode(state);
    c.uint8.preencode(state);
    c.uint8.preencode(state);
    c.uint8.preencode(state);
  },
  encode(state, event) {
    c.uint64.encode(state, event.timestamp);
    c.uint64.encode(state, event.edge_id);
    c.uint8.encode(state, event.speed_kph);
    c.uint8.encode(state, event.confidence);
    c.uint8.encode(state, event.flags);
  },
  decode(state) {
    return {
      timestamp: c.uint64.decode(state),
      edge_id: c.uint64.decode(state),
      speed_kph: c.uint8.decode(state),
      confidence: c.uint8.decode(state),
      flags: c.uint8.decode(state)
    };
  }
};

function normalizeUint64(value, fieldName) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`${fieldName} must be non-negative`);
    }
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return value;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer or bigint`);
  }
  return value;
}

function normalizeUint8(value, fieldName) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${fieldName} must be an integer in [0, 255]`);
  }
  return value;
}

export function validateTelemetry19(event) {
  if (!event || typeof event !== "object") {
    throw new Error("Telemetry event must be an object");
  }

  return {
    timestamp: normalizeUint64(event.timestamp, "timestamp"),
    edge_id: normalizeUint64(event.edge_id, "edge_id"),
    speed_kph: normalizeUint8(event.speed_kph, "speed_kph"),
    confidence: normalizeUint8(event.confidence, "confidence"),
    flags: normalizeUint8(event.flags, "flags")
  };
}

export function encodeTelemetry19(event) {
  const normalized = validateTelemetry19(event);
  const buffer = c.encode(telemetry19Encoding, normalized);
  if (buffer.byteLength !== TELEMETRY_PAYLOAD_BYTES) {
    throw new Error(
      `Telemetry payload must be exactly ${TELEMETRY_PAYLOAD_BYTES} bytes, got ${buffer.byteLength}`
    );
  }
  return buffer;
}

export function decodeTelemetry19(buffer) {
  if (!buffer || buffer.byteLength !== TELEMETRY_PAYLOAD_BYTES) {
    throw new Error(
      `Telemetry payload must be exactly ${TELEMETRY_PAYLOAD_BYTES} bytes, got ${buffer?.byteLength ?? "unknown"}`
    );
  }

  const decoded = c.decode(telemetry19Encoding, buffer);
  return validateTelemetry19(decoded);
}
