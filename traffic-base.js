/**
 * Autobase traffic log orchestration:
 * merges telemetry and dynamic writer membership into a verified shared view.
 */
import c from "compact-encoding";
import b4a from "b4a";
import Autobase from "autobase";
import {
  decodeTelemetry,
  encodeTelemetry,
  verifyWitnessSignature
} from "./telemetry-encoder.js";

const MESSAGE_TYPE_TELEMETRY = 1;
const MESSAGE_TYPE_ADD_WRITER = 2;
const DEFAULT_MIN_VALID_WITNESSES = 2;

const autobaseMessageEncoding = {
  preencode(state, message) {
    c.uint8.preencode(state, message.type);
    if (message.type === MESSAGE_TYPE_TELEMETRY) {
      c.raw.uint8array.preencode(state, message.payload);
      return;
    }
    if (message.type === MESSAGE_TYPE_ADD_WRITER) {
      c.fixed32.preencode(state, message.writerKey);
      return;
    }
    throw new Error(`Unknown Autobase message type: ${message.type}`);
  },
  encode(state, message) {
    c.uint8.encode(state, message.type);
    if (message.type === MESSAGE_TYPE_TELEMETRY) {
      c.raw.uint8array.encode(state, message.payload);
      return;
    }
    if (message.type === MESSAGE_TYPE_ADD_WRITER) {
      c.fixed32.encode(state, message.writerKey);
      return;
    }
    throw new Error(`Unknown Autobase message type: ${message.type}`);
  },
  decode(state) {
    const type = c.uint8.decode(state);
    if (type === MESSAGE_TYPE_TELEMETRY) {
      return { type, payload: c.raw.uint8array.decode(state) };
    }
    if (type === MESSAGE_TYPE_ADD_WRITER) {
      return { type, writerKey: c.fixed32.decode(state) };
    }
    throw new Error(`Unknown Autobase message type: ${type}`);
  }
};

function openTrafficView(store) {
  return store.get({ name: "traffic-view", valueEncoding: "binary" });
}

export async function applyTrafficUpdates(nodes, view, host) {
  for (const node of nodes) {
    if (!node || node.value == null) continue;

    const message = node.value;
    if (message.type === MESSAGE_TYPE_ADD_WRITER) {
      await host.addWriter(message.writerKey, { indexer: true });
      continue;
    }

    if (message.type === MESSAGE_TYPE_TELEMETRY) {
      const event = decodeTelemetry(message.payload);
      const minValidWitnesses =
        host?.security?.minValidWitnesses ?? DEFAULT_MIN_VALID_WITNESSES;
      const validWitnesses = countValidWitnessSignatures(event);

      if (validWitnesses < minValidWitnesses) {
        continue;
      }

      await view.append(encodeTelemetry(event));
      continue;
    }

    throw new Error(`Unsupported traffic message type: ${message.type}`);
  }
}

function countValidWitnessSignatures(event) {
  const signatures = Array.isArray(event?.neighbor_signatures)
    ? event.neighbor_signatures
    : [];
  const seenWitnesses = new Set();
  let validCount = 0;

  for (const witness of signatures) {
    try {
      const witnessKeyHex = b4a.toString(witness.witness_public_key, "hex");
      if (seenWitnesses.has(witnessKeyHex)) continue;
      if (!verifyWitnessSignature(event, witness)) continue;

      seenWitnesses.add(witnessKeyHex);
      validCount += 1;
    } catch {
      // Ignore malformed witness records and count only valid cryptographic attestations.
    }
  }

  return validCount;
}

export function createTrafficBase(store, bootstrap = null) {
  return new Autobase(store, bootstrap, {
    open: openTrafficView,
    apply: applyTrafficUpdates,
    valueEncoding: autobaseMessageEncoding
  });
}

export async function appendTelemetryEvent(base, event) {
  const payload = encodeTelemetry(event, event?.encodingOptions);
  await base.append({
    type: MESSAGE_TYPE_TELEMETRY,
    payload
  });
}

export async function appendAddWriterMessage(base, writerKey) {
  await base.append({
    type: MESSAGE_TYPE_ADD_WRITER,
    writerKey: b4a.from(writerKey)
  });
}

export async function getLatestSpeedForEdge(base, edgeId) {
  await base.update();

  for (let i = base.view.length - 1; i >= 0; i--) {
    const event = decodeTelemetry(await base.view.get(i));
    if (event.edge_id === edgeId) {
      return event.speed_kph;
    }
  }

  return null;
}
