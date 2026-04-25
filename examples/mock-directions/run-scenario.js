import fs from "node:fs/promises";
import path from "node:path";
import { createPathGenerator, estimateSpeedKmh } from "../../backend/src/sim/path.js";
import { initStorage } from "../../backend/src/storage/corestore.js";
import { SwarmMesh } from "../../backend/src/swarm/mesh.js";

function resolveScenarioPath(inputPath) {
  if (!inputPath) {
    return path.resolve("./examples/mock-directions/scenarios/same-cell.json");
  }

  if (inputPath.startsWith("./") || inputPath.startsWith("/")) {
    return path.resolve(inputPath);
  }

  return path.resolve("./examples/mock-directions/scenarios", inputPath);
}

async function loadScenario() {
  const scenarioPath = resolveScenarioPath(process.argv[2]);
  const scenarioRaw = await fs.readFile(scenarioPath, "utf8");
  return JSON.parse(scenarioRaw);
}

async function startCar(carConfig, scenarioConfig) {
  const storage = await initStorage({
    baseDirectory: carConfig.storageDir,
    telemetryCoreName: carConfig.telemetryCoreName
  });
  const mesh = new SwarmMesh({
    h3Resolution: scenarioConfig.h3Resolution,
    nodeLabel: carConfig.id
  });
  const nextPathPoint = createPathGenerator({
    routeWaypoints: carConfig.routeWaypoints,
    interpolationStepsPerSegment: scenarioConfig.interpolationStepsPerSegment
  });

  let previousPosition = null;
  const runTick = async () => {
    const position = nextPathPoint();
    const speed = Number(
      estimateSpeedKmh(previousPosition, position, scenarioConfig.tickMs).toFixed(2)
    );
    const topicState = await mesh.updatePosition(position);
    await storage.appendTelemetry({
      timestamp: Date.now(),
      lat: position.lat,
      lon: position.lon,
      speed,
      h3Cell: topicState.h3Cell
    });

    console.log(
      `[car:${carConfig.id}] lat=${position.lat.toFixed(6)} lon=${position.lon.toFixed(6)} h3=${topicState.h3Cell} rotated=${topicState.didRotate} speed=${speed}`
    );
    previousPosition = position;
  };

  return {
    id: carConfig.id,
    tickMs: scenarioConfig.tickMs,
    runTick,
    async close() {
      await mesh.close();
      await storage.close();
    }
  };
}

async function run() {
  const scenario = await loadScenario();
  console.log(`[scenario] ${scenario.name}: ${scenario.description}`);

  const cars = await Promise.all(
    scenario.cars.map((carConfig) => startCar(carConfig, scenario))
  );

  let shuttingDown = false;
  const loops = cars.map((car) =>
    (async () => {
      while (!shuttingDown) {
        try {
          await car.runTick();
        } catch (error) {
          console.error(`[car:${car.id}] tick failed`, error);
        }
        await new Promise((resolve) => setTimeout(resolve, car.tickMs));
      }
    })()
  );
  console.log(`[scenario] running for ${scenario.durationMs}ms`);

  const shutdown = async () => {
    shuttingDown = true;
    await Promise.all(loops);
    await Promise.all(cars.map((car) => car.close()));
    console.log("[scenario] shutdown complete");
  };

  setTimeout(() => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[scenario] shutdown error", error);
        process.exit(1);
      });
  }, scenario.durationMs);

  process.once("SIGINT", () => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("[scenario] shutdown error", error);
        process.exit(1);
      });
  });
}

run().catch((error) => {
  console.error("[scenario] fatal error", error);
  process.exit(1);
});
