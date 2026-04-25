import c from "compact-encoding";

export const TELEMETRY_PAYLOAD_SIZE = 19;

export const telemetryEncoding = {
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

function validateTelemetryEvent(event) {
  if (event == null || typeof event !== "object") {
    throw new Error("Telemetry event must be an object");
  }

  const { timestamp, edge_id, speed_kph, confidence, flags } = event;

  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("timestamp must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(edge_id) || edge_id < 0) {
    throw new Error("edge_id must be a non-negative safe integer");
  }
  if (!Number.isInteger(speed_kph) || speed_kph < 0 || speed_kph > 255) {
    throw new Error("speed_kph must be an integer in [0, 255]");
  }
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 255) {
    throw new Error("confidence must be an integer in [0, 255]");
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 255) {
    throw new Error("flags must be an integer in [0, 255]");
  }
}

export function encodeTelemetry(event) {
  validateTelemetryEvent(event);
  const buffer = c.encode(telemetryEncoding, event);
  if (buffer.byteLength !== TELEMETRY_PAYLOAD_SIZE) {
    throw new Error(
      `Telemetry payload must be ${TELEMETRY_PAYLOAD_SIZE} bytes, got ${buffer.byteLength}`
    );
  }
  return buffer;
}

export function decodeTelemetry(buffer) {
  if (!buffer || buffer.byteLength !== TELEMETRY_PAYLOAD_SIZE) {
    throw new Error(
      `Telemetry payload must be ${TELEMETRY_PAYLOAD_SIZE} bytes, got ${buffer?.byteLength ?? "unknown"}`
    );
  }
  return c.decode(telemetryEncoding, buffer);
}
