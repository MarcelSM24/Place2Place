import Hyperswarm from "hyperswarm";
import b4a from "b4a";
import { deriveDiscoveryTopic } from "./topic.js";

export class SwarmMesh {
  constructor({ h3Resolution, nodeLabel = "node" }) {
    this.h3Resolution = h3Resolution;
    this.nodeLabel = nodeLabel;
    this.swarm = new Hyperswarm();
    this.currentCell = null;
    this.currentTopic = null;
    this.currentDiscovery = null;
    this.connections = new Set();

    this.swarm.on("connection", (socket, peerInfo) => {
      const peerKey = b4a.toString(peerInfo.publicKey, "hex");
      this.connections.add(socket);
      console.log(`[mesh:${this.nodeLabel}] connected peer=${peerKey}`);

      socket.on("close", () => {
        this.connections.delete(socket);
        console.log(`[mesh:${this.nodeLabel}] disconnected peer=${peerKey}`);
      });
    });
  }

  async updatePosition(position) {
    const next = deriveDiscoveryTopic(position, this.h3Resolution);

    if (next.h3Cell === this.currentCell) {
      return {
        ...next,
        didRotate: false
      };
    }

    await this.rotateTopic(next);

    return {
      ...next,
      didRotate: true
    };
  }

  async rotateTopic(nextTopic) {
    if (this.currentTopic) {
      this.swarm.leave(this.currentTopic);
    }

    this.currentDiscovery = this.swarm.join(nextTopic.topicBuffer);
    await this.currentDiscovery.flushed();

    this.currentCell = nextTopic.h3Cell;
    this.currentTopic = nextTopic.topicBuffer;

    console.log(
      `[mesh:${this.nodeLabel}] topic updated h3=${nextTopic.h3Cell} topic=${b4a.toString(nextTopic.topicBuffer, "hex")}`
    );
  }

  async close() {
    for (const socket of this.connections) {
      socket.destroy();
    }
    await this.swarm.destroy();
  }
}
