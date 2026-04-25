import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import test from "brittle";
import Corestore from "corestore";
import {
  appendAddWriterMessage,
  appendTelemetryEvent,
  createTrafficBase
} from "./traffic-base.js";
import { createWitnessSignature, decodeTelemetry } from "./telemetry-encoder.js";
import { deriveDiscoveryTopic } from "./backend/src/swarm/topic.js";

const require = createRequire(import.meta.url);
const { sync } = require("autobase-test-helpers");

class TopicReplicationHarness {
  constructor() {
    this.topics = new Map();
  }

  join(peer, topicHex) {
    let topicState = this.topics.get(topicHex);
    if (!topicState) {
      topicState = {
        members: new Set(),
        links: new Map()
      };
      this.topics.set(topicHex, topicState);
    }

    for (const other of topicState.members) {
      this.#connectPeers(topicState, peer, other);
    }
    topicState.members.add(peer);
  }

  leave(peer, topicHex) {
    const topicState = this.topics.get(topicHex);
    if (!topicState) return;

    topicState.members.delete(peer);
    for (const [pairKey, link] of topicState.links) {
      if (link.peerA === peer || link.peerB === peer) {
        link.streamA.destroy();
        link.streamB.destroy();
        link.peerA.connectedPeers.delete(link.peerB.id);
        link.peerB.connectedPeers.delete(link.peerA.id);
        topicState.links.delete(pairKey);
      }
    }

    if (topicState.members.size === 0) {
      this.topics.delete(topicHex);
    }
  }

  #connectPeers(topicState, peerA, peerB) {
    const pairKey =
      peerA.id < peerB.id ? `${peerA.id}|${peerB.id}` : `${peerB.id}|${peerA.id}`;
    if (topicState.links.has(pairKey)) return;

    const streamA = peerA.base.replicate(true);
    const streamB = peerB.base.replicate(false);
    streamA.pipe(streamB).pipe(streamA);

    topicState.links.set(pairKey, { peerA, peerB, streamA, streamB });
    peerA.connectedPeers.add(peerB.id);
    peerB.connectedPeers.add(peerA.id);
  }
}

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createPeer(id, bootstrapKey = null) {
  const storageDir = await createTempDir(`mesh-peer-${id}-`);
  const store = new Corestore(storageDir);
  const base = createTrafficBase(store, bootstrapKey);
  await base.ready();

  return {
    id,
    storageDir,
    store,
    base,
    connectedPeers: new Set()
  };
}

function createSignedEvent(event) {
  const witnessA = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8"
  });
  const witnessB = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8"
  });
  const signable = { ...event, neighbor_signatures: [] };

  return {
    ...signable,
    neighbor_signatures: [
      createWitnessSignature(signable, witnessA),
      createWitnessSignature(signable, witnessB)
    ]
  };
}

async function collectViewEvents(base) {
  await base.update();
  const events = [];
  for (let i = 0; i < base.view.length; i++) {
    events.push(decodeTelemetry(await base.view.get(i)));
  }
  return events;
}

async function closePeers(peers) {
  await Promise.all(
    peers.map(async (peer) => {
      await peer.base.close();
      await peer.store.close();
      await fs.rm(peer.storageDir, { recursive: true, force: true });
    })
  );
}

test("Dense urban cell: five peers converge to identical Autobase state", async (t) => {
  const peers = [];
  try {
    const peer0 = await createPeer("p0");
    peers.push(peer0);
    for (let i = 1; i < 5; i++) {
      peers.push(await createPeer(`p${i}`, peer0.base.key));
    }

    const harness = new TopicReplicationHarness();
    const topicHex = deriveDiscoveryTopic(
      { lat: 40.7128, lon: -74.006 },
      8,
      "mesh-test"
    ).topicBuffer.toString("hex");

    await t.test("join and authorize all peers", async (st) => {
      for (const peer of peers) harness.join(peer, topicHex);

      for (let i = 1; i < peers.length; i++) {
        await appendAddWriterMessage(peer0.base, peers[i].base.local.key);
      }
      await sync(peers.map((p) => p.base));
      st.pass("all peers joined the same topic and synchronized writers");
    });

    await t.test("concurrent writes from all peers", async (st) => {
      await Promise.all(
        peers.map((peer, index) =>
          appendTelemetryEvent(
            peer.base,
            createSignedEvent({
              timestamp: 1715000000000 + index,
              edge_id: 900 + index,
              speed_kph: 30 + index,
              confidence: 210,
              flags: 0
            })
          )
        )
      );
      await sync(peers.map((p) => p.base));
      st.pass("concurrent writes completed and replicated");
    });

    await t.test("all peers converge to identical chronological state", async (st) => {
      const expected = await collectViewEvents(peers[0].base);
      st.is(expected.length, 5, "all five telemetry events are linearized");
      for (const peer of peers) {
        const actual = await collectViewEvents(peer.base);
        st.alike(actual, expected, `peer ${peer.id} converges to same chronological view`);
      }
    });
  } finally {
    await closePeers(peers);
  }
});

test("Boundary handoff: peer rotates topics and continues writing", async (t) => {
  const peers = [];
  try {
    const peerA = await createPeer("A");
    const peerB = await createPeer("B", peerA.base.key);
    const peerC = await createPeer("C", peerA.base.key);
    const peerD = await createPeer("D", peerA.base.key);
    peers.push(peerA, peerB, peerC, peerD);

    const harness = new TopicReplicationHarness();
    const topic1 = deriveDiscoveryTopic(
      { lat: 40.7128, lon: -74.006 },
      8,
      "mesh-test"
    ).topicBuffer.toString("hex");
    const topic2 = deriveDiscoveryTopic(
      { lat: 40.73061, lon: -73.935242 },
      8,
      "mesh-test"
    ).topicBuffer.toString("hex");

    await t.test("join initial topics and seed topic 1 data", async (st) => {
      harness.join(peerA, topic1);
      harness.join(peerB, topic1);
      harness.join(peerC, topic2);
      harness.join(peerD, topic2);

      await appendAddWriterMessage(peerA.base, peerB.base.local.key);
      await sync([peerA.base, peerB.base]);

      await appendTelemetryEvent(
        peerA.base,
        createSignedEvent({
          timestamp: 1715001000000,
          edge_id: 1001,
          speed_kph: 42,
          confidence: 220,
          flags: 1
        })
      );
      await sync([peerA.base, peerB.base]);
      st.pass("topic 1 initialized and synchronized");
    });

    let localLengthBeforeHandoff = 0;
    await t.test("migrate peer A across H3 boundary", async (st) => {
      localLengthBeforeHandoff = peerA.base.local.length;
      harness.leave(peerA, topic1);
      harness.join(peerA, topic2);

      st.is(peerA.connectedPeers.has("B"), false, "peer A disconnects from topic 1 peer");
      st.ok(
        peerA.connectedPeers.has("C") || peerA.connectedPeers.has("D"),
        "peer A connects to peers in topic 2"
      );
    });

    await t.test("continue writing on continuous local log post-handoff", async (st) => {
      await appendAddWriterMessage(peerA.base, peerC.base.local.key);
      await appendAddWriterMessage(peerA.base, peerD.base.local.key);
      await sync([peerA.base, peerC.base, peerD.base]);

      await appendTelemetryEvent(
        peerA.base,
        createSignedEvent({
          timestamp: 1715001000500,
          edge_id: 1002,
          speed_kph: 53,
          confidence: 225,
          flags: 0
        })
      );
      await sync([peerA.base, peerC.base, peerD.base]);

      st.ok(
        peerA.base.local.length > localLengthBeforeHandoff,
        "peer A local hypercore continues appending after handoff"
      );
    });

    await t.test("validate continuity and replicated history", async (st) => {
      const eventsOnC = await collectViewEvents(peerC.base);
      const edgeIds = eventsOnC.map((e) => e.edge_id);
      st.ok(edgeIds.includes(1001), "topic 1 event remains in continuous log history");
      st.ok(edgeIds.includes(1002), "topic 2 event is appended post-handoff");
    });
  } finally {
    await closePeers(peers);
  }
});

test("Store-carry-forward: ferry relays event across partition", async (t) => {
  const peers = [];
  try {
    const peerA = await createPeer("A");
    const peerB = await createPeer("B", peerA.base.key);
    const peerC = await createPeer("C", peerA.base.key);
    peers.push(peerA, peerB, peerC);

    const harness = new TopicReplicationHarness();
    const topic1 = deriveDiscoveryTopic(
      { lat: 40.7128, lon: -74.006 },
      8,
      "mesh-test"
    ).topicBuffer.toString("hex");
    const topic2 = deriveDiscoveryTopic(
      { lat: 34.0522, lon: -118.2437 },
      8,
      "mesh-test"
    ).topicBuffer.toString("hex");

    await t.test("join partitioned topics and prepare writers", async (st) => {
      harness.join(peerA, topic1);
      harness.join(peerB, topic1);
      harness.join(peerC, topic2);

      await appendAddWriterMessage(peerA.base, peerB.base.local.key);
      await appendAddWriterMessage(peerA.base, peerC.base.local.key);
      await sync([peerA.base, peerB.base]);
      st.pass("initial partition topology established");
    });

    await t.test("peer B carries event from topic 1", async (st) => {
      const trafficJamEvent = createSignedEvent({
        timestamp: 1715002000000,
        edge_id: 7777,
        speed_kph: 4,
        confidence: 240,
        flags: 2
      });

      await appendTelemetryEvent(peerA.base, trafficJamEvent);
      await sync([peerA.base, peerB.base]);

      const bEvents = await collectViewEvents(peerB.base);
      st.ok(
        bEvents.some((event) => event.edge_id === 7777),
        "peer B downloads peer A event while in topic 1"
      );
    });

    await t.test("peer B migrates and relays to topic 2", async (st) => {
      harness.leave(peerB, topic1);
      harness.join(peerB, topic2);

      st.is(peerB.connectedPeers.has("A"), false, "peer B disconnects from peer A");
      st.ok(peerB.connectedPeers.has("C"), "peer B connects with peer C in topic 2");

      await sync([peerB.base, peerC.base]);

      const cEvents = await collectViewEvents(peerC.base);
      st.ok(
        cEvents.some((event) => event.edge_id === 7777),
        "peer C receives traffic jam event authored by peer A via ferry peer B"
      );
    });
  } finally {
    await closePeers(peers);
  }
});
