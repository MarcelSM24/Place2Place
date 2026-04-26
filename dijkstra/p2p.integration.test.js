import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import test from "brittle";
import { createRequire } from "node:module";
import Corestore from "corestore";
import { Vehicle } from "./simulation.js";
import { calculateRoute, getHexFromLatLng } from "./routing.js";
import { appendAddWriterMessage, appendTelemetryEvent, createTrafficBase } from "../traffic-base.js";
import { createWitnessSignature, decodeTelemetry } from "../telemetry-encoder.js";

const require = createRequire(import.meta.url);
const { sync } = require("autobase-test-helpers");

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

test("dijkstra simulation telemetry replicates over p2p autobase", async (t) => {
  const localDir = await createTempDir("dijkstra-p2p-local-");
  const remoteDir = await createTempDir("dijkstra-p2p-remote-");

  const localStore = new Corestore(localDir);
  const remoteStore = new Corestore(remoteDir);

  const replicationA = localStore.replicate(true);
  const replicationB = remoteStore.replicate(false);
  replicationA.pipe(replicationB).pipe(replicationA);

  const localBase = createTrafficBase(localStore);
  await localBase.ready();
  const remoteBase = createTrafficBase(remoteStore, localBase.key);
  await remoteBase.ready();

  await appendAddWriterMessage(localBase, remoteBase.local.key);
  await sync([localBase, remoteBase], { checkHash: false });

  const startHex = getHexFromLatLng(41.387, 2.17);
  const endHex = getHexFromLatLng(41.395, 2.19);
  const route = calculateRoute(startHex, endHex);
  t.ok(route.length >= 2, "route has enough steps for simulation");

  const vehicle = new Vehicle("car-a", route[0], route);
  const emittedEdgeIds = [];

  for (let i = 0; i < Math.min(3, route.length); i++) {
    if (i > 0) vehicle.move();
    const event = createSignedEvent(vehicle.getTelemetryEvent());
    emittedEdgeIds.push(event.edge_id);
    await appendTelemetryEvent(localBase, event);
    await sync([localBase, remoteBase], { checkHash: false });
  }

  await remoteBase.update();
  const replicatedEdgeIds = [];
  for (let i = 0; i < remoteBase.view.length; i++) {
    const decoded = decodeTelemetry(await remoteBase.view.get(i));
    replicatedEdgeIds.push(decoded.edge_id);
  }

  for (const edgeId of emittedEdgeIds) {
    t.ok(replicatedEdgeIds.includes(edgeId), `replicated telemetry contains edge ${edgeId}`);
  }

  await localBase.close();
  await remoteBase.close();
  replicationA.destroy();
  replicationB.destroy();
  await localStore.close();
  await remoteStore.close();
  await fs.rm(localDir, { recursive: true, force: true });
  await fs.rm(remoteDir, { recursive: true, force: true });
});
