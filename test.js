/**
 * Root integration tests for encoding, Autobase convergence, and launcher/peer process behavior.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fork } from "node:child_process";
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForCondition(conditionFn, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function waitForChildExit(child, timeoutMs = 10000) {
  if (!child || child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve())),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
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

test("peer-node survives IPC disconnect and exits on SIGTERM", async (t) => {
  const peerNodePath = path.resolve("./backend/src/peer-node.js");
  const child = fork(peerNodePath, {
    env: {
      ...process.env,
      P2P_PEER_ID: "991",
      P2P_TICK_MS: "250",
      P2P_FIXED_SPEED: "10"
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });

  const pid = child.pid;
  t.ok(isProcessAlive(pid), "peer process is running after spawn");

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    child.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    t.ok(isProcessAlive(pid), "peer keeps running after IPC disconnect");
  } finally {
    if (isProcessAlive(pid)) {
      child.kill("SIGTERM");
    }
    await waitForChildExit(child);
  }

  t.absent(isProcessAlive(pid), "peer exits after SIGTERM");
});

test("index launcher exits while detached peers keep running", async (t) => {
  const indexPath = path.resolve("./backend/src/index.js");
  const marker = `isolation-${Date.now()}`;
  const testStorageBase = path.resolve(os.tmpdir(), `p2p-isolation-${Date.now()}`);
  const child = fork(indexPath, {
    env: {
      ...process.env,
      P2P_STARTUP_VEHICLES: "3",
      P2P_FRONTEND_PORT: "0",
      P2P_PEER_MARKER: marker,
      P2P_STORAGE_BASE: testStorageBase,
      P2P_TELEMETRY_CORE_NAME: `telemetry-${marker}`
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });

  const launcherPid = child.pid;
  let peerPids = [];
  try {
    const peersReady = await waitForCondition(async () => {
      const out = await fs.readFile(`/tmp/p2p-marker-${marker}.txt`, "utf8").catch(() => "");
      if (!out) return false;
      peerPids = out
        .trim()
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      return peerPids.length >= 3 && peerPids.every((pid) => isProcessAlive(pid));
    }, 15000);

    t.ok(peersReady, "launcher spawned detached peers");
    t.ok(isProcessAlive(launcherPid), "launcher process is alive before termination");

    child.kill("SIGTERM");
    await waitForChildExit(child);
    t.absent(isProcessAlive(launcherPid), "launcher exits on SIGTERM");

    const peersStillAlive = await waitForCondition(
      async () => peerPids.length >= 3 && peerPids.every((pid) => isProcessAlive(pid)),
      5000
    );
    t.ok(peersStillAlive, "detached peers remain alive after launcher exit");
  } finally {
    for (const pid of peerPids) {
      if (isProcessAlive(pid)) {
        process.kill(pid, "SIGTERM");
      }
    }
    await waitForChildExit(child);
    await fs.rm(`/tmp/p2p-marker-${marker}.txt`, { force: true });
    await fs.rm(testStorageBase, { recursive: true, force: true });
  }
});
