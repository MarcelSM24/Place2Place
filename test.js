import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import test from "brittle";
import Corestore from "corestore";
import {
  appendAddWriterMessage,
  appendTelemetryEvent,
  createTrafficBase,
  getLatestSpeedForEdge
} from "./traffic-base.js";
import {
  BASE_TELEMETRY_PAYLOAD_SIZE,
  createWitnessSignature,
  decodeTelemetry,
  encodeTelemetry
} from "./telemetry-encoder.js";

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function replicateStores(a, b) {
  const s1 = a.replicate(true);
  const s2 = b.replicate(false);
  s1.pipe(s2).pipe(s1);
  return [s1, s2];
}

async function waitFor(conditionFn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function createSignedEvent(event) {
  const witnessA = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8"
  });
  const witnessB = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8"
  });
  const signable = { ...event, neighbor_signatures: [] };
  return {
    ...signable,
    neighbor_signatures: [
      createWitnessSignature(signable, witnessA),
      createWitnessSignature(signable, witnessB)
    ]
  };
}

test("telemetry encoding includes witness signatures and decodes correctly", async (t) => {
  const input = {
    timestamp: 1712345678901,
    edge_id: 42,
    speed_kph: 73,
    confidence: 215,
    flags: 3,
    neighbor_signatures: []
  };
  input.neighbor_signatures = createSignedEvent(input).neighbor_signatures;

  const encoded = encodeTelemetry(input);
  t.ok(
    encoded.byteLength >= BASE_TELEMETRY_PAYLOAD_SIZE,
    "payload includes base telemetry bytes plus witness attestations"
  );

  const decoded = decodeTelemetry(encoded);
  t.is(decoded.timestamp, input.timestamp, "timestamp decodes");
  t.is(decoded.edge_id, input.edge_id, "edge id decodes");
  t.is(decoded.speed_kph, input.speed_kph, "speed decodes");
  t.is(decoded.confidence, input.confidence, "confidence decodes");
  t.is(decoded.flags, input.flags, "flags decodes");
  t.is(
    decoded.neighbor_signatures.length,
    input.neighbor_signatures.length,
    "witness signature count decodes"
  );
});

test("autobase linearizes local and remote writers to latest speed", async (t) => {
  const localDir = await createTempDir("p2p-local-");
  const remoteDir = await createTempDir("p2p-remote-");

  const localStore = new Corestore(localDir);
  const remoteStore = new Corestore(remoteDir);
  const [replicationA, replicationB] = replicateStores(localStore, remoteStore);

  const localBase = createTrafficBase(localStore);
  await localBase.ready();

  const remoteBase = createTrafficBase(remoteStore, localBase.key);
  await remoteBase.ready();

  await appendAddWriterMessage(localBase, remoteBase.local.key);
  await localBase.update();
  await remoteBase.update();

  await waitFor(async () => {
    await remoteBase.update();
    return remoteBase.writable;
  });

  const edgeId = 777;
  await appendTelemetryEvent(localBase, createSignedEvent({
    timestamp: 1710000000000,
    edge_id: edgeId,
    speed_kph: 25,
    confidence: 200,
    flags: 0
  }));

  await appendTelemetryEvent(remoteBase, createSignedEvent({
    timestamp: 1710000001000,
    edge_id: edgeId,
    speed_kph: 61,
    confidence: 220,
    flags: 1
  }));

  await localBase.update();
  await remoteBase.update();

  await waitFor(async () => {
    const latest = await getLatestSpeedForEdge(localBase, edgeId);
    return latest === 61;
  });

  const latestLocal = await getLatestSpeedForEdge(localBase, edgeId);
  const latestRemote = await getLatestSpeedForEdge(remoteBase, edgeId);
  t.is(latestLocal, 61, "local view returns most recent edge speed");
  t.is(latestRemote, 61, "remote view converges to same most recent edge speed");

  await localBase.close();
  await remoteBase.close();
  replicationA.destroy();
  replicationB.destroy();
  await localStore.close();
  await remoteStore.close();
});
