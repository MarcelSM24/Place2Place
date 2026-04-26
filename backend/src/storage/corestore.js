/**
 * Corestore bootstrap helpers for creating, reading, and closing local telemetry Hypercores.
 */
import fs from "node:fs/promises";
import path from "node:path";
import Corestore from "corestore";
import { decodeTelemetry19, encodeTelemetry19 } from "../telemetry-encoder.js";

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
      const encodedPayload = encodeTelemetry19(eventPayload);
      await telemetryCore.append(encodedPayload);
    },
    async getTelemetryAt(index) {
      const buffer = await telemetryCore.get(index);
      return decodeTelemetry19(buffer);
    },
    async close() {
      await telemetryCore.close();
      await corestore.close();
    }
  };
}
