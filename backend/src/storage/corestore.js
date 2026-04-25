import fs from "node:fs/promises";
import path from "node:path";
import Corestore from "corestore";
import b4a from "b4a";

export async function initStorage(storageConfig) {
  const dataDirectory = path.resolve(storageConfig.baseDirectory);
  await fs.mkdir(dataDirectory, { recursive: true });

  const corestore = new Corestore(dataDirectory);
  await corestore.ready();

  const telemetryCore = corestore.get({ name: storageConfig.telemetryCoreName });
  await telemetryCore.ready();

  return {
    corestore,
    telemetryCore,
    async appendTelemetry(eventPayload) {
      const encodedPayload = b4a.from(JSON.stringify(eventPayload));
      await telemetryCore.append(encodedPayload);
    },
    async close() {
      await telemetryCore.close();
      await corestore.close();
    }
  };
}
