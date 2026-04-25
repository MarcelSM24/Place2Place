import c from "compact-encoding";
import b4a from "b4a";
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";

export const BASE_TELEMETRY_PAYLOAD_SIZE = 19;

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
    c.uint64.preencode(state);
    c.uint64.preencode(state);
    c.uint8.preencode(state);
    c.uint8.preencode(state);
    c.uint8.preencode(state);
    c.array(witnessSignatureEncoding).preencode(state, event.neighbor_signatures);
  },
  encode(state, event) {
    c.uint64.encode(state, event.timestamp);
    c.uint64.encode(state, event.edge_id);
    c.uint8.encode(state, event.speed_kph);
    c.uint8.encode(state, event.confidence);
    c.uint8.encode(state, event.flags);
    c.array(witnessSignatureEncoding).encode(state, event.neighbor_signatures);
  },
  decode(state) {
    return {
      timestamp: c.uint64.decode(state),
      edge_id: c.uint64.decode(state),
      speed_kph: c.uint8.decode(state),
      confidence: c.uint8.decode(state),
      flags: c.uint8.decode(state),
      neighbor_signatures: c.array(witnessSignatureEncoding).decode(state)
    };
  }
};

const telemetrySigningEncoding = {
  preencode(state, event) {
    c.uint64.preencode(state, event.timestamp);
    c.uint64.preencode(state, event.edge_id);
    c.uint8.preencode(state, event.speed_kph);
    c.uint8.preencode(state, event.confidence);
    c.uint8.preencode(state, event.flags);
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
