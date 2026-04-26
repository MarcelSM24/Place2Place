/**
 * Gateway runtime entrypoint:
 * serves the frontend, spawns peer workers, and mirrors aggregated P2P traffic to WebSocket clients.
 */
import { SIMULATION_CONFIG, STORAGE_CONFIG } from "./config.js";
import { initStorage } from "./storage/corestore.js";
import { SwarmMesh } from "./swarm/mesh.js";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import express from "express";
import { WebSocketServer } from "ws";
import { calculateRoute, getHexFromLatLng } from "../../dijkstra/routing.js";
import { appendAddWriterMessage, createTrafficBase } from "../../traffic-base.js";
import { decodeTelemetry } from "../../telemetry-encoder.js";

async function main() {
  const app = express();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicDir = path.resolve(__dirname, "../../public");
  const rootDir = path.resolve(__dirname, "../../");
  const preferredPort = Number(process.env.P2P_FRONTEND_PORT ?? 3000);

  app.use(express.static(publicDir));
  app.use("/Logo.png", express.static(path.resolve(rootDir, "Logo.png")));
  const { server, port } = await listenWithFallback(app, preferredPort);
  console.log(`[frontend] serving map UI at http://localhost:${port}`);

  const wss = new WebSocketServer({ server });
  const configuredStorageBase =
    process.env.P2P_STORAGE_BASE ?? `${STORAGE_CONFIG.baseDirectory}-gateway`;
  const configuredTelemetryCoreName =
    process.env.P2P_TELEMETRY_CORE_NAME ?? STORAGE_CONFIG.telemetryCoreName;
  const storage = await initStorageWithFallback({
    ...STORAGE_CONFIG,
    baseDirectory: configuredStorageBase,
    telemetryCoreName: configuredTelemetryCoreName
  });
  const gatewayPublicKeyHex = Buffer.from(storage.telemetryCore.key).toString("hex");
  const gatewayStore = storage.corestore.namespace(`gateway-${gatewayPublicKeyHex.slice(0, 24)}`);
  const trafficBase = createTrafficBase(gatewayStore);
  await trafficBase.ready();
  const mesh = new SwarmMesh({
    h3Resolution: SIMULATION_CONFIG.h3Resolution,
    nodeLabel: "gateway"
  });
  await mesh.updatePosition({
    lat: SIMULATION_CONFIG.startPosition.lat,
    lon: SIMULATION_CONFIG.startPosition.lon
  });
  const knownWriterKeys = new Set();
  const announcedWriterKeys = new Set();
  let viewCursor = 0;
  const latestSpeedByPublicKey = new Map();

  let isShuttingDown = false;
  const terminatePeersOnExit = process.env.P2P_TERMINATE_PEERS_ON_EXIT === "1";
  const workerProcesses = new Map();
  const peerLaunchEnv = new Map();
  const peerState = new Map();
  const peerMarker = process.env.P2P_PEER_MARKER ?? "";
  const markerPath = peerMarker ? `/tmp/p2p-marker-${peerMarker}.txt` : null;
  const PEER_COUNT = Number(process.env.P2P_STARTUP_VEHICLES ?? 10);
  let nextPeerId = PEER_COUNT + 1;

  const peerNodePath = path.resolve(__dirname, "./peer-node.js");

  const broadcast = (payload) => {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      client.send(JSON.stringify(payload));
    }
  };

  mesh.swarm.on("connection", async (socket, peerInfo) => {
    storage.corestore.replicate(socket);
    const remoteKey = peerInfo?.publicKey;
    const remoteKeyHex = remoteKey ? Buffer.from(remoteKey).toString("hex") : null;
    if (!remoteKey || !remoteKeyHex || knownWriterKeys.has(remoteKeyHex)) return;
    try {
      if (!announcedWriterKeys.has(remoteKeyHex)) {
        await appendAddWriterMessage(trafficBase, remoteKey);
        announcedWriterKeys.add(remoteKeyHex);
      }
      await trafficBase.update();
      knownWriterKeys.add(remoteKeyHex);
    } catch (error) {
      console.warn(
        `[gateway] failed addWriter ${remoteKeyHex.slice(0, 12)}: ${error?.message ?? "unknown"}`
      );
    }
  });

  const consumeTrafficBaseEvents = async () => {
    await trafficBase.update();
    let hasUpdates = false;
    while (viewCursor < trafficBase.view.length) {
      const event = decodeTelemetry(await trafficBase.view.get(viewCursor));
      const witnessKey = event?.neighbor_signatures?.[0]?.witness_public_key;
      const publicKey = witnessKey
        ? Buffer.from(witnessKey).toString("hex")
        : `unknown-${viewCursor}`;
      latestSpeedByPublicKey.set(publicKey, event.speed_kph ?? 0);
      viewCursor += 1;
      hasUpdates = true;
    }
    if (hasUpdates) {
      broadcast({
        type: "trafficMirror",
        speeds: Array.from(latestSpeedByPublicKey.entries()).map(([publicKey, speed_kph]) => ({
          publicKey,
          speed_kph
        }))
      });
    }
  };

  const startPeerNode = async (peerId, extraEnv = {}) => {
    peerLaunchEnv.set(peerId, extraEnv);
    const child = fork(peerNodePath, {
      env: {
        ...process.env,
        P2P_PEER_ID: String(peerId),
        P2P_TICK_MS: String(SIMULATION_CONFIG.tickMs),
        ...extraEnv
      },
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    child.unref();
    workerProcesses.set(peerId, child);
    peerState.set(peerId, {
      id: peerId,
      status: "running",
      launchedAt: Date.now()
    });
    broadcast({ type: "peerLifecycle", peerId, status: "running" });
    if (markerPath) {
      const pids = Array.from(workerProcesses.values())
        .map((proc) => proc.pid)
        .filter((pid) => Number.isInteger(pid));
      await fs.writeFile(markerPath, pids.join(","), "utf8");
    }

    child.on("exit", (code, signal) => {
      workerProcesses.delete(peerId);
      peerState.set(peerId, {
        ...peerState.get(peerId),
        status: "exited",
        exitCode: code ?? null,
        signal: signal ?? null
      });
      broadcast({
        type: "peerLifecycle",
        peerId,
        status: "exited",
        code: code ?? null,
        signal: signal ?? null
      });
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
        peers: Array.from(peerState.values())
      })
    );

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data?.type === "setRoute") {
          if (
            Number.isFinite(data?.origin?.lat) &&
            Number.isFinite(data?.origin?.lng)
          ) {
            await mesh.updatePosition({
              lat: data.origin.lat,
              lon: data.origin.lng
            });
          }
          const peerId = Number(data.peerId ?? 1);
          const child = workerProcesses.get(peerId);
          if (!child) return;
          const originHex = getHexFromLatLng(data.origin.lat, data.origin.lng);
          const destinationHex = getHexFromLatLng(
            data.destination.lat,
            data.destination.lng
          );
          const route = calculateRoute(originHex, destinationHex);
          child.send({
            type: "control:setRoute",
            originHex,
            destinationHex,
            route,
          });
          peerState.set(peerId, {
            ...peerState.get(peerId),
            activeRouteLength: route.length,
            updatedAt: Date.now()
          });
          broadcast({
            type: "routeAssigned",
            peerId,
            routeLength: route.length
          });
        } else if (data?.type === "stressTest") {
          const spawnHex = typeof data.spawnHex === "string" ? data.spawnHex : undefined;
          const destinationHex =
            typeof data.destinationHex === "string" ? data.destinationHex : undefined;
          const jamPeerId = nextPeerId;
          nextPeerId += 1;
          await startPeerNode(jamPeerId, {
            ...(spawnHex ? { P2P_START_HEX: spawnHex } : {}),
            ...(destinationHex ? { P2P_TARGET_HEX: destinationHex } : {}),
            P2P_FIXED_SPEED: "5"
          });
          ws.send(
            JSON.stringify({
              type: "trafficJam",
              message: `Peer de atasco #${jamPeerId} creado con velocidad 5.`
            })
          );
        } else if (data?.type === "launchPeer") {
          const launchedPeerId = nextPeerId;
          nextPeerId += 1;
          await startPeerNode(launchedPeerId, data.env ?? {});
          ws.send(
            JSON.stringify({
              type: "peerLifecycle",
              peerId: launchedPeerId,
              status: "running"
            })
          );
        } else if (data?.type === "gatewayPosition") {
          if (
            Number.isFinite(data?.lat) &&
            Number.isFinite(data?.lng)
          ) {
            const topicState = await mesh.updatePosition({
              lat: data.lat,
              lon: data.lng
            });
            ws.send(
              JSON.stringify({
                type: "gatewayTopic",
                h3Cell: topicState.h3Cell,
                didRotate: topicState.didRotate
              })
            );
          }
        }
      } catch {
        // Ignore malformed frontend messages.
      }
    });
  });

  const mirrorLoop = async () => {
    while (!isShuttingDown) {
      try {
        await consumeTrafficBaseEvents();
      } catch (error) {
        console.error("[gateway] mirror update failed", error);
      }
      await new Promise((resolve) => setTimeout(resolve, SIMULATION_CONFIG.tickMs));
    }
  };

  const mirrorLoopPromise = mirrorLoop();

  const shutdown = async (signal) => {
    isShuttingDown = true;
    console.log(`[app] received ${signal}, shutting down...`);
    if (terminatePeersOnExit) {
      for (const child of workerProcesses.values()) {
        child.kill("SIGTERM");
      }
    }
    await mirrorLoopPromise;
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

function listenOnce(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
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
      `[gateway] storage fallback to ${fallbackConfig.baseDirectory} due to DEVICE_FILE`
    );
    return initStorage(fallbackConfig);
  }
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

main().catch((error) => {
  console.error("[app] fatal startup error", error);
  process.exit(1);
});
