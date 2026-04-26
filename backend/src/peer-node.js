/**
 * Autonomous peer process:
 * simulates movement, joins geographic swarm topics, publishes signed telemetry, and reacts to congestion.
 */
import h3 from "h3-js";
import { generateKeyPairSync } from "node:crypto";
import { SIMULATION_CONFIG, STORAGE_CONFIG } from "./config.js";
import { initStorage } from "./storage/corestore.js";
import { SwarmMesh } from "./swarm/mesh.js";
import { deriveDiscoveryTopic } from "./swarm/topic.js";
import { RoutingBridge } from "./routing-bridge.js";
import {
  appendAddWriterMessage,
  appendTelemetryEvent,
  createTrafficBase
} from "../../traffic-base.js";
import { createWitnessSignature, decodeTelemetry } from "../../telemetry-encoder.js";
import { encodeTelemetry19 } from "./telemetry-encoder.js";
import {
  calculateRoute,
  getHexFromLatLng,
  getEdgeIdForSegment
} from "../../dijkstra/routing.js";

const peerId = Number(process.env.P2P_PEER_ID ?? 1);
const tickMs = Number(process.env.P2P_TICK_MS ?? SIMULATION_CONFIG.tickMs);
const hexStepMeters = Number(process.env.P2P_HEX_STEP_METERS ?? 14);
let forcedStartHex = process.env.P2P_START_HEX || null;
let forcedDestinationHex = process.env.P2P_TARGET_HEX || null;
const configuredFixedSpeed = Number(process.env.P2P_FIXED_SPEED);
const fixedSpeed = Number.isFinite(configuredFixedSpeed)
  ? clamp(Math.round(configuredFixedSpeed), 0, 120)
  : null;
const LOOKAHEAD_CELLS = Number(process.env.P2P_LOOKAHEAD_CELLS ?? 8);

let isShuttingDown = false;

function randomWithin(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeStepAdvanceMetersPerTick(speedKph) {
  const metersPerSecond = Math.max(0, speedKph) / 3.6;
  return (metersPerSecond * tickMs) / 1000;
}

function createRandomSeedPosition() {
  return {
    lat: SIMULATION_CONFIG.startPosition.lat + randomWithin(-0.01, 0.01),
    lng: SIMULATION_CONFIG.startPosition.lon + randomWithin(-0.015, 0.015)
  };
}

function createRandomDestination() {
  return {
    // Keep destinations near the visible map area.
    lat: clamp(SIMULATION_CONFIG.startPosition.lat + randomWithin(-0.008, 0.008), 41.36, 41.41),
    lng: clamp(SIMULATION_CONFIG.startPosition.lon + randomWithin(-0.012, 0.012), 2.14, 2.20)
  };
}

async function initStorageWithFallback(storageConfig) {
  try {
    return await initStorage(storageConfig);
  } catch (error) {
    const fallbackConfig = {
      ...storageConfig,
      baseDirectory: `${storageConfig.baseDirectory}-peer-${peerId}-${Date.now()}`
    };
    console.warn(
      `[peer:${peerId}] storage fallback to ${fallbackConfig.baseDirectory} due to ${error?.code ?? "unknown"}`
    );
    return initStorage(fallbackConfig);
  }
}

async function main() {
  if (process.channel) {
    process.channel.unref();
  }
  process.on("disconnect", () => {
    // Parent launcher exited; peer keeps running as an autonomous node.
  });

  const configuredStorageBase = process.env.P2P_STORAGE_BASE;
  const storage = await initStorageWithFallback({
    ...STORAGE_CONFIG,
    baseDirectory: configuredStorageBase
      ? `${configuredStorageBase}-peer-${peerId}`
      : `${STORAGE_CONFIG.baseDirectory}-peer-${peerId}`,
    telemetryCoreName: process.env.P2P_TELEMETRY_CORE_NAME
      ? `${process.env.P2P_TELEMETRY_CORE_NAME}-peer-${peerId}`
      : `telemetry-peer-${peerId}`
  });
  const mesh = new SwarmMesh({
    h3Resolution: SIMULATION_CONFIG.h3Resolution,
    nodeLabel: `peer-${peerId}`
  });
  let identityCell = null;
  let identityEpoch = 0;
  const connectionPeerKeyBySocket = new Map();
  const lookaheadJoins = new Map();

  const createIdentityRuntime = async (cell) => {
    identityEpoch += 1;
    const scopedStore = storage.corestore.namespace(
      `peer-${peerId}-cell-${cell}-epoch-${identityEpoch}`
    );
    const trafficBase = createTrafficBase(scopedStore);
    await trafficBase.ready();
    return {
      trafficBase,
      witnessKeys: [createWitnessKey(), createWitnessKey()],
      viewCursor: 0,
      knownWriterKeys: new Set(),
      announcedWriterKeys: new Set()
    };
  };

  let runtime = null;

  const seed = createRandomSeedPosition();
  let currentHex = forcedStartHex ?? getHexFromLatLng(seed.lat, seed.lng);
  let route = [currentHex];
  let routeIndex = 0;
  let speed = fixedSpeed ?? Math.round(randomWithin(28, 58));
  let pendingStepMeters = 0;
  const routingBridge = new RoutingBridge({
    onRouteUpdate(nextRoute) {
      if (!Array.isArray(nextRoute) || nextRoute.length < 1) return;
      route = nextRoute;
      routeIndex = 0;
      currentHex = route[0] ?? currentHex;
      pendingStepMeters = 0;
      syncLookAheadTopics();
      console.log(`[peer:${peerId}] rerouted via P2P view routeLength=${nextRoute.length}`);
    }
  });

  const buildRouteFromCurrentHex = () => {
    if (forcedDestinationHex) {
      try {
        const candidate = calculateRoute(currentHex, forcedDestinationHex);
        if (Array.isArray(candidate) && candidate.length > 1) {
          return candidate;
        }
      } catch {
        // Fallback to random destinations if forced target is temporarily unreachable.
      }
    }

    let nextRoute = [currentHex];
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const destination = createRandomDestination();
      const destinationHex = getHexFromLatLng(destination.lat, destination.lng);
      try {
        const candidate = calculateRoute(currentHex, destinationHex);
        if (Array.isArray(candidate) && candidate.length > 1) {
          nextRoute = candidate;
          break;
        }
      } catch {
        // Ignore and try another random destination.
      }
    }
    return nextRoute;
  };

  route = buildRouteFromCurrentHex();
  routeIndex = 0;
  currentHex = route[0] ?? currentHex;
  identityCell = currentHex;
  runtime = await createIdentityRuntime(identityCell);
  routingBridge.setActiveTrip({
    route,
    destinationHex: forcedDestinationHex,
    currentHex
  });

  process.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type !== "control:setRoute") return;
    if (!Array.isArray(message.route) || message.route.length < 1) return;

    const nextRoute = message.route.filter((hex) => typeof hex === "string");
    if (nextRoute.length < 1) return;

    forcedStartHex = typeof message.originHex === "string" ? message.originHex : nextRoute[0];
    forcedDestinationHex =
      typeof message.destinationHex === "string"
        ? message.destinationHex
        : nextRoute[nextRoute.length - 1];
    route = nextRoute;
    routeIndex = 0;
    currentHex = route[0];
    pendingStepMeters = 0;
    syncLookAheadTopics();
    routingBridge.setActiveTrip({
      route,
      destinationHex: forcedDestinationHex,
      currentHex
    });
  });

  mesh.swarm.on("connection", async (socket, peerInfo) => {
    storage.corestore.replicate(socket);
    const remoteKey = peerInfo?.publicKey;
    if (remoteKey) {
      connectionPeerKeyBySocket.set(socket, Buffer.from(remoteKey));
    }
    socket.on("close", () => {
      connectionPeerKeyBySocket.delete(socket);
    });
    await ensureWriterForRuntime(remoteKey);
  });

  async function ensureWriterForRuntime(remoteKey) {
    const remoteKeyHex = remoteKey ? Buffer.from(remoteKey).toString("hex") : null;
    if (!remoteKey || !remoteKeyHex || runtime.knownWriterKeys.has(remoteKeyHex)) {
      return;
    }
    try {
      if (!runtime.announcedWriterKeys.has(remoteKeyHex)) {
        await appendAddWriterMessage(runtime.trafficBase, remoteKey);
        runtime.announcedWriterKeys.add(remoteKeyHex);
      }
      await runtime.trafficBase.update();
      runtime.knownWriterKeys.add(remoteKeyHex);
      console.log(`[peer:${peerId}] added remote writer ${remoteKeyHex.slice(0, 12)}`);
    } catch (error) {
      console.warn(
        `[peer:${peerId}] failed to add writer ${remoteKeyHex.slice(0, 12)}: ${error?.message ?? "unknown"}`
      );
    }
  }

  async function rotateIdentity(nextCell) {
    if (!nextCell || nextCell === identityCell) return;
    const previousRuntime = runtime;
    runtime = await createIdentityRuntime(nextCell);
    identityCell = nextCell;
    console.log(`[peer:${peerId}] rotated ephemeral identity h3=${nextCell} epoch=${identityEpoch}`);

    for (const key of connectionPeerKeyBySocket.values()) {
      await ensureWriterForRuntime(key);
    }
    await previousRuntime.trafficBase.close();
  }

  async function syncLookAheadTopics() {
    const nextCells = new Set();
    for (let i = routeIndex + 1; i < route.length && nextCells.size < LOOKAHEAD_CELLS; i += 1) {
      const cell = route[i];
      if (typeof cell === "string" && cell !== identityCell) {
        nextCells.add(cell);
      }
    }

    for (const [cell, discovery] of lookaheadJoins.entries()) {
      if (nextCells.has(cell)) continue;
      mesh.swarm.leave(discovery.topicBuffer);
      lookaheadJoins.delete(cell);
    }

    for (const cell of nextCells) {
      if (lookaheadJoins.has(cell)) continue;
      const [lat, lon] = h3.cellToLatLng(cell);
      const discovery = deriveDiscoveryTopic(
        { lat, lon },
        SIMULATION_CONFIG.h3Resolution
      );
      const joinHandle = mesh.swarm.join(discovery.topicBuffer);
      await joinHandle.flushed();
      lookaheadJoins.set(cell, discovery);
    }

    if (nextCells.size > 0) {
      const [curLat, curLon] = h3.cellToLatLng(currentHex);
      let furthestKm = 0;
      for (const cell of nextCells) {
        const [lat, lon] = h3.cellToLatLng(cell);
        const distKm = h3.greatCircleDistance([curLat, curLon], [lat, lon], "km");
        furthestKm = Math.max(furthestKm, distKm);
      }
      if (furthestKm >= 5) {
        console.log(
          `[peer:${peerId}] look-ahead discovery active up to ${furthestKm.toFixed(2)}km ahead`
        );
      }
    }
  }

  const consumeTrafficBaseEvents = async () => {
    await runtime.trafficBase.update();
    while (runtime.viewCursor < runtime.trafficBase.view.length) {
      const decoded = decodeTelemetry(await runtime.trafficBase.view.get(runtime.viewCursor));
      const rerouteResult = routingBridge.ingestTelemetry(decoded);
      if (rerouteResult?.rerouted) {
        console.log(`[peer:${peerId}] route recomputed from distributed traffic event`);
      }
      runtime.viewCursor += 1;
    }
  };

  const tick = async () => {
    const hasNext = route.length > 1 && routeIndex < route.length - 1;
    if (hasNext) {
      if (fixedSpeed != null) {
        speed = fixedSpeed;
      } else {
        speed = clamp(Math.round(speed + randomWithin(-10, 14)), 20, 120);
      }
      pendingStepMeters += computeStepAdvanceMetersPerTick(speed);
      const stepCount = Math.min(
        route.length - 1 - routeIndex,
        Math.floor(pendingStepMeters / hexStepMeters)
      );
      if (stepCount > 0) {
        routeIndex += stepCount;
        currentHex = route[routeIndex];
        pendingStepMeters -= stepCount * hexStepMeters;
      }
    } else {
      speed = 0;
      pendingStepMeters = 0;
      if (!forcedDestinationHex) {
        route = buildRouteFromCurrentHex();
        routeIndex = 0;
        currentHex = route[0] ?? currentHex;
        syncLookAheadTopics();
        routingBridge.setActiveTrip({
          route,
          destinationHex: forcedDestinationHex,
          currentHex
        });
        if (route.length > 1) {
          speed = fixedSpeed ?? clamp(Math.round(randomWithin(30, 60)), 20, 120);
          pendingStepMeters = 0;
        }
      }
    }

    const nextHex = route[routeIndex + 1];
    const edgeId = nextHex ? getEdgeIdForSegment(currentHex, nextHex) ?? 0 : 0;

    const telemetryEvent = {
      timestamp: Date.now(),
      edge_id: edgeId,
      speed_kph: speed,
      confidence: 180,
      flags: 0
    };

    if (currentHex !== identityCell) {
      await rotateIdentity(currentHex);
    }

    await storage.telemetryCore.append(encodeTelemetry19(telemetryEvent));
    await appendTelemetryEvent(
      runtime.trafficBase,
      signTelemetryEvent(telemetryEvent, runtime.witnessKeys)
    );
    await consumeTrafficBaseEvents();
    const [emitLat, emitLng] = h3.cellToLatLng(currentHex);
    const topicState = await mesh.updatePosition({ lat: emitLat, lon: emitLng });
    if (topicState.didRotate) {
      await rotateIdentity(topicState.h3Cell);
    }
    await syncLookAheadTopics();
    routingBridge.updateCurrentHex(currentHex);
    console.log(
      `[peer:${peerId}] lat=${emitLat.toFixed(6)} lon=${emitLng.toFixed(6)} edge=${edgeId} speed=${speed} h3=${topicState.h3Cell} peers=${mesh.connections.size}`
    );
  };

  const tickLoop = async () => {
    while (!isShuttingDown) {
      try {
        await tick();
      } catch (error) {
        console.error(`[peer:${peerId}] tick failed`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, tickMs));
    }
  };

  const loopPromise = tickLoop();

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    await loopPromise;
    for (const discovery of lookaheadJoins.values()) {
      mesh.swarm.leave(discovery.topicBuffer);
    }
    await runtime.trafficBase.close();
    await mesh.close();
    await storage.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`[peer:${peerId}] fatal startup error`, error);
  process.exit(1);
});

function createWitnessKey() {
  return generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8"
  });
}

function signTelemetryEvent(event, witnessPrivateKeys) {
  const signable = { ...event, neighbor_signatures: [] };
  return {
    ...signable,
    neighbor_signatures: witnessPrivateKeys.map((key) =>
      createWitnessSignature(signable, key)
    )
  };
}
