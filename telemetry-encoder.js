/**
 * Shared telemetry payload format with witness signatures and optional local differential privacy noise.
 */
import c from "compact-encoding";
import b4a from "b4a";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import {
  decodeTelemetry19,
  encodeTelemetry19,
  TELEMETRY_PAYLOAD_BYTES,
  validateTelemetry19
} from "./backend/src/telemetry-encoder.js";

export const BASE_TELEMETRY_PAYLOAD_SIZE = TELEMETRY_PAYLOAD_BYTES;

const witnessSignatureEncoding = {
  preencode(state, witness) {
    c.uint8array.preencode(state, witness.witness_public_key);
    c.uint8array.preencode(state, witness.signature);
  },
  encode(state, witness) {
    c.uint8array.encode(state, witness.witness_public_key);
    c.uint8array.encode(state, witness.signature);
  },
  decode(state) {
    return {
      witness_public_key: c.uint8array.decode(state),
      signature: c.uint8array.decode(state)
    };
  }
};

export const telemetryEncoding = {
  preencode(state, event) {
    const payload = encodeTelemetry19(event);
    c.uint8array.preencode(state, payload);
    c.array(witnessSignatureEncoding).preencode(state, event.neighbor_signatures);
  },
  encode(state, event) {
    const payload = encodeTelemetry19(event);
    c.uint8array.encode(state, payload);
    c.array(witnessSignatureEncoding).encode(state, event.neighbor_signatures);
  },
  decode(state) {
    const payload = c.uint8array.decode(state);
    const decoded = decodeTelemetry19(payload);
    return {
      timestamp: decoded.timestamp,
      edge_id: decoded.edge_id,
      speed_kph: decoded.speed_kph,
      confidence: decoded.confidence,
      flags: decoded.flags,
      neighbor_signatures: c.array(witnessSignatureEncoding).decode(state)
    };
  }
};

const telemetrySigningEncoding = {
  preencode(state, event) {
    const payload = encodeTelemetry19(event);
    c.uint8array.preencode(state, payload);
  },
  encode(state, event) {
    const payload = encodeTelemetry19(event);
    c.uint8array.encode(state, payload);
  },
  decode(state) {
    return decodeTelemetry19(c.uint8array.decode(state));
  }
};

function randomUnit() {
  return Math.random() - 0.5;
}

function laplaceNoise(scale) {
  if (!(scale > 0)) return 0;
  const u = randomUnit();
  const sign = u < 0 ? -1 : 1;
  return -sign * scale * Math.log(1 - 2 * Math.abs(u));
}

function toUint8Array(value, fieldName) {
  if (!value) {
    throw new Error(`${fieldName} must be a non-empty byte array`);
  }
  return b4a.from(value);
}

function validateTelemetryEvent(event, { requireSignatures = true } = {}) {
  if (event == null || typeof event !== "object") {
    throw new Error("Telemetry event must be an object");
  }

  const {
    timestamp,
    edge_id,
    speed_kph,
    confidence,
    flags,
    neighbor_signatures = []
  } = event;

  validateTelemetry19({ timestamp, edge_id, speed_kph, confidence, flags });

  if (!Array.isArray(neighbor_signatures)) {
    throw new Error("neighbor_signatures must be an array");
  }

  for (const witness of neighbor_signatures) {
    if (witness == null || typeof witness !== "object") {
      throw new Error("Each neighbor signature must be an object");
    }
    const witnessPublicKey = toUint8Array(
      witness.witness_public_key,
      "witness_public_key"
    );
    const signature = toUint8Array(witness.signature, "signature");
    if (witnessPublicKey.byteLength === 0) {
      throw new Error("witness_public_key cannot be empty");
    }
    if (signature.byteLength === 0) {
      throw new Error("signature cannot be empty");
    }
  }

  if (requireSignatures && neighbor_signatures.length === 0) {
    throw new Error("neighbor_signatures must contain at least one witness");
  }
}

export function addLocalDifferentialPrivacy(event, options = {}) {
  validateTelemetryEvent(
    {
      ...event,
      neighbor_signatures: event?.neighbor_signatures ?? []
    },
    { requireSignatures: false }
  );

  const epsilon = options.epsilon ?? 1.0;
  const sensitivity = options.sensitivity ?? 3.0;
  const scale = sensitivity / Math.max(epsilon, Number.EPSILON);

  const noisySpeed = Math.round(
    Math.max(0, Math.min(255, event.speed_kph + laplaceNoise(scale)))
  );
  const noisyConfidence = Math.round(
    Math.max(0, Math.min(255, event.confidence + laplaceNoise(scale / 2)))
  );

  return {
    ...event,
    speed_kph: noisySpeed,
    confidence: noisyConfidence
  };
}

export function encodeTelemetrySigningPayload(event) {
  validateTelemetryEvent(event, { requireSignatures: false });
  return c.encode(telemetrySigningEncoding, event);
}

export function createWitnessSignature(event, witnessPrivateKeyDer) {
  const payload = encodeTelemetrySigningPayload(event);
  const privateKey = createPrivateKey({
    key: b4a.from(witnessPrivateKeyDer),
    format: "der",
    type: "pkcs8"
  });
  const signature = cryptoSign(null, payload, privateKey);
  const publicKey = createPublicKey(privateKey).export({
    format: "der",
    type: "spki"
  });

  return {
    witness_public_key: b4a.from(publicKey),
    signature: b4a.from(signature)
  };
}

export function verifyWitnessSignature(event, witness) {
  validateTelemetryEvent(
    {
      ...event,
      neighbor_signatures: [witness]
    },
    { requireSignatures: false }
  );

  const payload = encodeTelemetrySigningPayload(event);
  const publicKey = createPublicKey({
    key: b4a.from(witness.witness_public_key),
    format: "der",
    type: "spki"
  });

  return cryptoVerify(null, payload, publicKey, b4a.from(witness.signature));
}

export function encodeTelemetry(event, options = {}) {
  const withPrivacy = options?.ldp?.enabled
    ? addLocalDifferentialPrivacy(event, options.ldp)
    : event;
  validateTelemetryEvent(withPrivacy);
  const buffer = c.encode(telemetryEncoding, withPrivacy);
  if (buffer.byteLength < BASE_TELEMETRY_PAYLOAD_SIZE) {
    throw new Error(
      `Telemetry payload must be at least ${BASE_TELEMETRY_PAYLOAD_SIZE} bytes, got ${buffer.byteLength}`
    );
  }
  return buffer;
}

export function decodeTelemetry(buffer) {
  if (!buffer || buffer.byteLength < BASE_TELEMETRY_PAYLOAD_SIZE) {
    throw new Error(
      `Telemetry payload must be at least ${BASE_TELEMETRY_PAYLOAD_SIZE} bytes, got ${buffer?.byteLength ?? "unknown"}`
    );
  }
  return c.decode(telemetryEncoding, buffer);
}
