import { SIMULATION_CONFIG, STORAGE_CONFIG } from "./config.js";
import { createPathGenerator, estimateSpeedKmh } from "./sim/path.js";
import { initStorage } from "./storage/corestore.js";
import { SwarmMesh } from "./swarm/mesh.js";

async function main() {
  const storage = await initStorage(STORAGE_CONFIG);
  const mesh = new SwarmMesh({
    h3Resolution: SIMULATION_CONFIG.h3Resolution,
    nodeLabel: "main"
  });

  const nextPathPoint = createPathGenerator({
    routeWaypoints: SIMULATION_CONFIG.routeWaypoints,
    interpolationStepsPerSegment: SIMULATION_CONFIG.interpolationStepsPerSegment
  });

  let previousPosition = null;
  let isShuttingDown = false;

  const tick = async () => {
    const position = nextPathPoint();
    const speedKmh = estimateSpeedKmh(
      previousPosition,
      position,
      SIMULATION_CONFIG.tickMs
    );
    const topicState = await mesh.updatePosition(position);

    const telemetryEvent = {
      timestamp: Date.now(),
      lat: position.lat,
      lon: position.lon,
      speed: Number(speedKmh.toFixed(2)),
      h3Cell: topicState.h3Cell
    };

    await storage.appendTelemetry(telemetryEvent);

    console.log(
      `[sim] lat=${position.lat.toFixed(6)} lon=${position.lon.toFixed(6)} speed=${telemetryEvent.speed}km/h h3=${topicState.h3Cell} rotated=${topicState.didRotate}`
    );

    previousPosition = position;
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
    await tickLoopPromise;
    await mesh.close();
    await storage.close();
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

main().catch((error) => {
  console.error("[app] fatal startup error", error);
  process.exit(1);
});
