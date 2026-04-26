import { SIMULATION_CONFIG, STORAGE_CONFIG } from "./config.js";
import { initStorage } from "./storage/corestore.js";
import { SwarmMesh } from "./swarm/mesh.js";
import { RoutingBridge } from "./routing-bridge.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import h3 from "h3-js";
import {
  createTrafficBase,
  appendAddWriterMessage,
  appendTelemetryEvent
} from "../../traffic-base.js";
import {
  calculateRoute,
  getEdgeIdForSegment,
  getHexFromLatLng
} from "../../dijkstra/routing.js";
import { createWitnessSignature, decodeTelemetry } from "../../telemetry-encoder.js";
import { generateKeyPairSync } from "node:crypto";

const HEX_STEP_METERS = Number(process.env.P2P_HEX_STEP_METERS ?? 14);

function computeStepAdvanceMetersPerTick(speedKph) {
  const metersPerSecond = Math.max(0, speedKph) / 3.6;
  return (metersPerSecond * SIMULATION_CONFIG.tickMs) / 1000;
}

async function main() {
  const app = express();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.resolve(__dirname, "../../public");
  const preferredPort = Number(process.env.P2P_FRONTEND_PORT ?? 3000);

  app.use(express.static(publicDir));
  const { server, port } = await listenWithFallback(app, preferredPort);
  console.log(`[frontend] serving map UI at http://localhost:${port}`);

  const wss = new WebSocketServer({ server });

  const storage = await initStorageWithFallback(STORAGE_CONFIG);
  const trafficBase = createTrafficBase(storage.corestore);
  await trafficBase.ready();

  const mesh = new SwarmMesh({
    h3Resolution: SIMULATION_CONFIG.h3Resolution,
    nodeLabel: "main"
  });

  let isShuttingDown = false;
  let viewCursor = 0;
  const witnessKeys = [createWitnessKey(), createWitnessKey()];
  let localVehicle = null;
  let currentDestination = null;
  let localPendingStepMeters = 0;
  const workerProcesses = new Map();
  const peerLaunchEnv = new Map();
  const vehicles = new Map();
  const peerRoutes = new Map();
  const PEER_COUNT = Number(process.env.P2P_STARTUP_VEHICLES ?? 10);
  let nextPeerId = PEER_COUNT + 1;

  const peerNodePath = path.resolve(__dirname, "./peer-node.js");

  const broadcast = (payload) => {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      client.send(JSON.stringify(payload));
    }
  };

  const consumeTrafficBaseEvents = async () => {
    await trafficBase.update();
    while (viewCursor < trafficBase.view.length) {
      const decoded = decodeTelemetry(await trafficBase.view.get(viewCursor));
      const rerouteResult = routingBridge.ingestTelemetry(decoded);
      viewCursor += 1;

      if (rerouteResult?.rerouted) {
        broadcast({
          type: "trafficJam",
          message: "Atasco detectado por la red P2P. Ruta recalculada."
        });
      }
    }
  };

  const routingBridge = new RoutingBridge({
    onRouteUpdate(route) {
      if (!localVehicle) return;
      localVehicle.route = route;
      localVehicle.position = 0;
      localVehicle.currentHex = route[0] ?? localVehicle.currentHex;
      routingBridge.setActiveTrip({
        route,
        destinationHex: currentDestination,
        currentHex: localVehicle.currentHex
      });
      broadcast({
        type: "routeUpdate",
        route: route.map((hex) => h3.cellToLatLng(hex))
      });
    }
  });

  const spawnMainVehicle = (origin) => {
    if (localVehicle) return localVehicle;
    const startHex = getHexFromLatLng(
      origin?.lat ?? SIMULATION_CONFIG.startPosition.lat,
      origin?.lng ?? SIMULATION_CONFIG.startPosition.lon
    );
    const [lat, lng] = h3.cellToLatLng(startHex);
    localVehicle = {
      id: 0,
      route: [startHex],
      position: 0,
      currentHex: startHex,
      speed: 0
    };
    vehicles.set(0, {
      id: 0,
      lat,
      lng,
      routeIndex: 0,
      speed: 0,
      source: "main"
    });
    console.log("[main] spawned manually");
    return localVehicle;
  };

  const registerPeerWriter = async (peerId) => {
    const writerKey = createHash("sha256")
      .update(`peer-writer-${peerId}`)
      .digest();
    await appendAddWriterMessage(trafficBase, writerKey);
  };

  const processIncomingTelemetry = async (payload) => {
    const telemetryEvent = payload.telemetryEvent;
    if (!telemetryEvent) return;
    const vehicleState = {
      id: payload.id,
      lat: payload.lat,
      lng: payload.lng,
      routeIndex: payload.routeIndex ?? 0,
      speed: telemetryEvent.speed_kph ?? 0,
      edge_id: telemetryEvent.edge_id ?? 0,
      h3Cell: payload.h3Cell,
      peers: payload.peers ?? 0,
      source: payload.source ?? "peer"
    };
    vehicles.set(payload.id, vehicleState);

    await appendTelemetryEvent(
      trafficBase,
      signTelemetryEvent(telemetryEvent, witnessKeys)
    );
    await consumeTrafficBaseEvents();

    broadcast({
      type: "telemetry",
      ...vehicleState
    });
  };

  const startPeerNode = async (peerId, extraEnv = {}) => {
    peerLaunchEnv.set(peerId, extraEnv);
    const child = spawn(process.execPath, [peerNodePath], {
      env: {
        ...process.env,
        P2P_PEER_ID: String(peerId),
        P2P_TICK_MS: String(SIMULATION_CONFIG.tickMs),
        ...extraEnv
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"]
    });
    workerProcesses.set(peerId, child);
    await registerPeerWriter(peerId);

    child.on("message", async (message) => {
      if (!message || typeof message !== "object") return;
      try {
        if (message.type === "telemetry") {
          await processIncomingTelemetry({
            ...message,
            source: "peer"
          });
        } else if (message.type === "peerRoute") {
          peerRoutes.set(message.id, message.route);
          broadcast({
            type: "peerRoute",
            id: message.id,
            route: message.route
          });
        } else if (message.type === "ready") {
          vehicles.set(message.id, {
            id: message.id,
            lat: message.lat,
            lng: message.lng,
            routeIndex: message.routeIndex ?? 0,
            speed: 0,
            source: "peer"
          });
        }
      } catch (error) {
        console.error(`[peer:${peerId}] failed to process message`, error);
      }
    });

    child.on("exit", (code, signal) => {
      workerProcesses.delete(peerId);
      if (isShuttingDown) return;
      console.warn(
        `[peer:${peerId}] exited code=${code ?? "null"} signal=${signal ?? "null"}, restarting`
      );
      startPeerNode(peerId, peerLaunchEnv.get(peerId) ?? {}).catch((error) =>
        console.error(`[peer:${peerId}] restart failed`, error)
      );
    });
  };

  for (let i = 1; i <= PEER_COUNT; i += 1) {
    await startPeerNode(i);
  }

  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: "init",
        vehicles: Array.from(vehicles.values()).map((vehicle) => ({
          id: vehicle.id,
          lat: vehicle.lat,
          lng: vehicle.lng
        }))
      })
    );

    for (const [peerId, route] of peerRoutes.entries()) {
      ws.send(
        JSON.stringify({
          type: "peerRoute",
          id: peerId,
          route
        })
      );
    }

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data?.type === "setRoute") {
          if (!localVehicle) {
            spawnMainVehicle(data.origin);
          }
          const originHex = getHexFromLatLng(data.origin.lat, data.origin.lng);
          const destinationHex = getHexFromLatLng(
            data.destination.lat,
            data.destination.lng
          );
          const route = calculateRoute(originHex, destinationHex);
          currentDestination = destinationHex;
          localVehicle.route = route;
          localVehicle.position = 0;
          localVehicle.currentHex = route[0] ?? localVehicle.currentHex;
          localPendingStepMeters = 0;
          routingBridge.setActiveTrip({
            route,
            destinationHex,
            currentHex: localVehicle.currentHex
          });
          broadcast({
            type: "route",
            route: route.map((hex) => h3.cellToLatLng(hex))
          });
        } else if (data?.type === "spawnMainVehicle") {
          const vehicle = spawnMainVehicle();
          const [lat, lng] = h3.cellToLatLng(vehicle.currentHex);
          broadcast({
            type: "telemetry",
            id: vehicle.id,
            lat,
            lng,
            routeIndex: vehicle.position,
            speed: vehicle.speed
          });
        } else if (data?.type === "stressTest") {
          if (!localVehicle) {
            ws.send(
              JSON.stringify({
                type: "trafficJam",
                message: "Primero debes crear el vehículo principal."
              })
            );
            return;
          }
          const currentPos = localVehicle.position;
          const route = localVehicle.route;
          if (!Array.isArray(route) || route.length < 4 || !currentDestination) {
            ws.send(
              JSON.stringify({
                type: "trafficJam",
                message: "Necesitas una ruta activa y destino para crear el peer de atasco."
              })
            );
            return;
          }

          const minSpawnIdx = currentPos + 30;
          const maxSpawnIdx = Math.min(route.length - 2, currentPos + 40);
          if (minSpawnIdx > maxSpawnIdx) {
            ws.send(
              JSON.stringify({
                type: "trafficJam",
                message: "El vehículo está muy cerca del destino para crear un peer de atasco."
              })
            );
            return;
          }

          const spawnIdx =
            minSpawnIdx +
            Math.floor(Math.random() * (maxSpawnIdx - minSpawnIdx + 1));
          const spawnHex = route[spawnIdx];
          const jamPeerId = nextPeerId;
          nextPeerId += 1;
          await startPeerNode(jamPeerId, {
            P2P_START_HEX: spawnHex,
            P2P_TARGET_HEX: currentDestination,
            P2P_FIXED_SPEED: "5"
          });
          ws.send(
            JSON.stringify({
              type: "trafficJam",
              message: `Peer de atasco #${jamPeerId} creado a ${spawnIdx - currentPos} paso(s) por delante con velocidad 5.`
            })
          );
        }
      } catch {
        // Ignore malformed frontend messages.
      }
    });
  });

  const tick = async () => {
    if (!localVehicle) return;
    const route = localVehicle.route;
    const hasNext = route.length > 1 && localVehicle.position < route.length - 1;
    if (hasNext) {
      localVehicle.speed = 70;
      localPendingStepMeters += computeStepAdvanceMetersPerTick(localVehicle.speed);
      const stepCount = Math.min(
        route.length - 1 - localVehicle.position,
        Math.floor(localPendingStepMeters / HEX_STEP_METERS)
      );
      if (stepCount > 0) {
        localVehicle.position += stepCount;
        localVehicle.currentHex = route[localVehicle.position];
        localPendingStepMeters -= stepCount * HEX_STEP_METERS;
      }
    } else {
      localVehicle.speed = 0;
      localPendingStepMeters = 0;
    }

    const [lat, lng] = h3.cellToLatLng(localVehicle.currentHex);
    routingBridge.updateCurrentHex(localVehicle.currentHex);
    const topicState = await mesh.updatePosition({ lat, lon: lng });

    const nextHex = route[localVehicle.position + 1];
    const edgeId = nextHex
      ? getEdgeIdForSegment(localVehicle.currentHex, nextHex) ?? 0
      : 0;
    const telemetryEvent = {
      timestamp: Date.now(),
      edge_id: edgeId,
      speed_kph: localVehicle.speed,
      confidence: 200,
      flags: 1
    };

    await storage.appendTelemetry(telemetryEvent);
    await appendTelemetryEvent(trafficBase, signTelemetryEvent(telemetryEvent, witnessKeys));
    await consumeTrafficBaseEvents();

    vehicles.set(localVehicle.id, {
      id: localVehicle.id,
      lat,
      lng,
      routeIndex: localVehicle.position,
      speed: telemetryEvent.speed_kph,
      edge_id: telemetryEvent.edge_id,
      h3Cell: topicState.h3Cell,
      peers: mesh.connections.size,
      source: "main"
    });

    broadcast({
      type: "telemetry",
      id: localVehicle.id,
      lat,
      lng,
      routeIndex: localVehicle.position,
      speed: telemetryEvent.speed_kph,
      edge_id: telemetryEvent.edge_id,
      h3Cell: topicState.h3Cell,
      peers: mesh.connections.size
    });

    console.log(
      `[sim] lat=${lat.toFixed(6)} lon=${lng.toFixed(6)} speed=${telemetryEvent.speed_kph}km/h edge=${telemetryEvent.edge_id} h3=${topicState.h3Cell} rotated=${topicState.didRotate}`
    );
  };

  const tickLoop = async () => {
    while (!isShuttingDown) {
      try {
        await tick();
      } catch (error) {
        console.error("[sim] tick failed", error);
      }
      await new Promise((resolve) => setTimeout(resolve, SIMULATION_CONFIG.tickMs));
    }
  };

  const tickLoopPromise = tickLoop();

  const shutdown = async (signal) => {
    isShuttingDown = true;
    console.log(`[app] received ${signal}, shutting down...`);
    for (const child of workerProcesses.values()) {
      child.kill("SIGTERM");
    }
    await tickLoopPromise;
    await trafficBase.close();
    await mesh.close();
    await storage.close();
    await new Promise((resolve) => wss.close(resolve));
    process.exit(0);
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("[app] shutdown failed", error);
      process.exit(1);
    });
  });

  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("[app] shutdown failed", error);
      process.exit(1);
    });
  });
}

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

function listenOnce(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function listenWithFallback(app, startPort, maxAttempts = 20) {
  let current = startPort;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const server = await listenOnce(app, current);
      return { server, port: current };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      current += 1;
    }
  }

  throw new Error(
    `Could not bind frontend server after ${maxAttempts} attempts starting from port ${startPort}`
  );
}

async function initStorageWithFallback(storageConfig) {
  try {
    return await initStorage(storageConfig);
  } catch (error) {
    if (error?.code !== "DEVICE_FILE") throw error;

    const fallbackConfig = {
      ...storageConfig,
      baseDirectory: `${storageConfig.baseDirectory}-runtime-${Date.now()}`
    };
    console.warn(
      `[storage] base directory unavailable, falling back to ${fallbackConfig.baseDirectory}`
    );
    return initStorage(fallbackConfig);
  }
}

main().catch((error) => {
  console.error("[app] fatal startup error", error);
  process.exit(1);
});
