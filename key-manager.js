/**
 * Ephemeral key lifecycle manager that rotates cryptographic identity by time or H3 boundary changes.
 */
import { randomBytes, generateKeyPairSync } from "node:crypto";

const DEFAULT_ROTATION_MS = 10 * 60 * 1000;

function generateEphemeralIdentity() {
  const signingPair = generateKeyPairSync("ed25519");
  return {
    createdAt: Date.now(),
    telemetryPrivateKeyDer: signingPair.privateKey.export({
      format: "der",
      type: "pkcs8"
    }),
    telemetryPublicKeyDer: signingPair.publicKey.export({
      format: "der",
      type: "spki"
    }),
    hypercoreKeyPairSeed: randomBytes(32),
    hyperswarmKeyPairSeed: randomBytes(32)
  };
}

export class EphemeralKeyManager {
  constructor(options = {}) {
    this.rotationIntervalMs = options.rotationIntervalMs ?? DEFAULT_ROTATION_MS;
    this.onRotate = options.onRotate ?? null;
    this.lastH3Cell = null;
    this.currentIdentity = generateEphemeralIdentity();
    this.rotationTimer = null;
  }

  start() {
    if (this.rotationTimer) return;
    this.rotationTimer = setInterval(() => {
      this.rotate({ reason: "interval" });
    }, this.rotationIntervalMs);
  }

  stop() {
    if (!this.rotationTimer) return;
    clearInterval(this.rotationTimer);
    this.rotationTimer = null;
  }

  getCurrentIdentity() {
    return this.currentIdentity;
  }

  updateH3Cell(nextH3Cell) {
    if (!nextH3Cell) return false;
    if (this.lastH3Cell == null) {
      this.lastH3Cell = nextH3Cell;
      return false;
    }
    if (this.lastH3Cell === nextH3Cell) return false;

    this.lastH3Cell = nextH3Cell;
    this.rotate({ reason: "h3-boundary" });
    return true;
  }

  rotate(metadata = {}) {
    const previousIdentity = this.currentIdentity;
    this.currentIdentity = generateEphemeralIdentity();

    if (typeof this.onRotate === "function") {
      this.onRotate({
        previousIdentity,
        nextIdentity: this.currentIdentity,
        metadata
      });
    }

    return this.currentIdentity;
  }
}

export function createEphemeralKeyManager(options = {}) {
  return new EphemeralKeyManager(options);
}
