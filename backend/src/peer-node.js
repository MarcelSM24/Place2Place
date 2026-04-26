import h3 from "h3-js";
import { SIMULATION_CONFIG, STORAGE_CONFIG } from "./config.js";
import { initStorage } from "./storage/corestore.js";
import { SwarmMesh } from "./swarm/mesh.js";
import {
  calculateRoute,
  getHexFromLatLng,
  getEdgeIdForSegment
} from "../../dijkstra/routing.js";

const peerId = Number(process.env.P2P_PEER_ID ?? 1);
const tickMs = Number(process.env.P2P_TICK_MS ?? SIMULATION_CONFIG.tickMs);
const hexStepMeters = Number(process.env.P2P_HEX_STEP_METERS ?? 14);
const forcedStartHex = process.env.P2P_START_HEX || null;
const forcedDestinationHex = process.env.P2P_TARGET_HEX || null;
const configuredFixedSpeed = Number(process.env.P2P_FIXED_SPEED);
const fixedSpeed = Number.isFinite(configuredFixedSpeed)
  ? clamp(Math.round(configuredFixedSpeed), 0, 120)
  : null;

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
  const storage = await initStorageWithFallback({
    ...STORAGE_CONFIG,
    baseDirectory: `${STORAGE_CONFIG.baseDirectory}-peer-${peerId}`,
    telemetryCoreName: `telemetry-peer-${peerId}`
  });
  const mesh = new SwarmMesh({
    h3Resolution: SIMULATION_CONFIG.h3Resolution,
    nodeLabel: `peer-${peerId}`
  });

  const seed = createRandomSeedPosition();
  let currentHex = forcedStartHex ?? getHexFromLatLng(seed.lat, seed.lng);
  let route = [currentHex];
  let routeIndex = 0;
  let speed = fixedSpeed ?? Math.round(randomWithin(28, 58));
  let pendingStepMeters = 0;

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

  const publishRoute = () => {
    process.send?.({
      type: "peerRoute",
      id: peerId,
      route: route.map((hex) => h3.cellToLatLng(hex))
    });
  };

  route = buildRouteFromCurrentHex();
  routeIndex = 0;
  currentHex = route[0] ?? currentHex;

  const [initialLat, initialLng] = h3.cellToLatLng(currentHex);
  process.send?.({
    type: "ready",
    id: peerId,
    lat: initialLat,
    lng: initialLng,
    routeIndex
  });
  publishRoute();

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
        if (route.length > 1) {
          speed = fixedSpeed ?? clamp(Math.round(randomWithin(30, 60)), 20, 120);
          pendingStepMeters = 0;
          publishRoute();
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

    await storage.appendTelemetry(telemetryEvent);
    const [emitLat, emitLng] = h3.cellToLatLng(currentHex);
    const topicState = await mesh.updatePosition({ lat: emitLat, lon: emitLng });
    process.send?.({
      type: "telemetry",
      id: peerId,
      lat: emitLat,
      lng: emitLng,
      routeIndex,
      h3Cell: topicState.h3Cell,
      peers: mesh.connections.size,
      telemetryEvent
    });
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
