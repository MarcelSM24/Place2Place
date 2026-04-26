# 🚗 PlaceToPlace

**PlaceToPlace** is a decentralized traffic and routing simulation where each car acts as a peer.  
Instead of relying on centralized traffic infrastructure, vehicles share local telemetry in a geographic P2P mesh and continuously adapt route decisions based on nearby network state.

## Inspiration

Urban traffic systems are usually coordinated through centralized services that can become expensive, fragile, or unavailable in constrained environments. We wanted to explore a different model: what if cars could coordinate traffic conditions directly with nearby peers, in real time, without requiring a global backend.

PlaceToPlace is inspired by decentralized communication systems, local-first design, and the idea that traffic intelligence can emerge from neighborhood-level collaboration rather than top-down control.

## What it does

- Simulates moving cars over a city-like graph.
- Discovers nearby peers using geographic partitioning (H3 cells) and Hyperswarm topics.
- Shares and replicates telemetry events (position, speed, timestamp) through per-peer append-only logs.
- Merges multi-writer traffic updates into a consistent local view using Autobase.
- Streams aggregated state to the web map through a local WebSocket bridge.
- Supports dynamic congestion behavior and route adaptation in the interface.

## How we built it

- **Spatial discovery:** `h3-js` converts GPS-like coordinates into hex cells so peers discover only relevant neighbors.
- **P2P networking:** `hyperswarm` handles peer discovery and secure connectivity over DHT topics derived from geographic cells.
- **Data model:** each peer writes movement events to its own `hypercore`; `corestore` manages local + remote cores.
- **State convergence:** `autobase` linearizes multiple writers into an eventually consistent traffic timeline.
- **Frontend bridge:** a local `ws` server pushes live aggregated traffic events to the browser map.
- **Routing simulation:** local route logic applies congestion penalties and rerouting behavior for observable network effects.

## Challenges we ran into

- Avoiding global broadcast behavior while preserving enough local connectivity for useful routing updates.
- Coordinating topic transitions when peers move between H3 regions.
- Designing state flow so multi-writer updates remain understandable and debuggable in real time.
- Balancing simulation realism with responsiveness and reproducibility during local development.
- Keeping the frontend experience smooth while backend peer topology changes frequently.

## Accomplishments that we're proud of

- Built an end-to-end decentralized runtime where simulated vehicles discover, connect, and sync traffic telemetry.
- Replaced centralized state sharing with geographically scoped P2P collaboration.
- Connected backend distributed state to a real-time frontend visualization via WebSockets.
- Created a solid foundation for future routing intelligence integrations.

## What we learned

- Geographic partitioning is essential for scalable peer discovery in mobility-focused systems.
- Single-writer logs plus deterministic merge layers are a practical pattern for decentralized telemetry.
- Real-time visual feedback dramatically improves debugging of distributed behavior.
- Local-first architecture design forces clearer boundaries between transport, storage, and UI concerns.

## What's next for PlaceToPlace

- Integrate route engines (for example, Valhalla) to compute optimal paths from decentralized live traffic state.
- Improve peer handoff and continuity when vehicles cross H3 boundaries.
- Add richer telemetry signals (incidents, lane slowdowns, confidence scores).
- Expand simulation scenarios and stress-test under larger peer populations.
- Continue hardening the Pear/Holepunch-aligned backend runtime for production-like environments.
