# File Documentation (Short Resume)

This checklist documents all tracked files in this repository using short summaries.

## Task 1 - Project Root and Meta Files

- [x] `.cursor/rules/principal-rule.mdc` - Workspace rule that defines P2P/Holepunch architecture constraints and coding focus.
- [x] `.gitignore` - Ignore rules for generated artifacts, dependencies, and local runtime files.
- [x] `LICENSE` - Project license terms.
- [x] `Logo.png` - Brand/logo image used by the frontend UI.
- [x] `README.md` - Main project overview, setup commands, and documentation index.
- [x] `package.json` - Root scripts and dependencies for backend, routing demo, examples, and tests.
- [x] `package-lock.json` - Locked dependency tree for reproducible installs.
- [x] `key-manager.js` - Ephemeral identity/key rotation utilities for privacy-preserving peer identity changes.
- [x] `telemetry-encoder.js` - Shared telemetry encoding/decoding plus witness-signature signing and verification.
- [x] `traffic-base.js` - Autobase message model and apply logic that merges telemetry and writer announcements.
- [x] `test.js` - Core tests for telemetry encoding, Autobase convergence, and process lifecycle behavior.
- [x] `mesh-simulation.test.js` - Topology simulation tests for churn, handoff, ferrying, and convergence across scenarios.

## Task 2 - Backend Runtime (`backend/src`)

- [x] `backend/src/config.js` - Simulation and storage defaults (ticks, H3 resolution, start position, waypoint loop).
- [x] `backend/src/index.js` - Gateway entrypoint: serves UI, runs WS bridge, launches peer workers, mirrors aggregated traffic.
- [x] `backend/src/peer-node.js` - Autonomous vehicle peer process: route following, telemetry emission, swarm joins, rerouting.
- [x] `backend/src/routing-bridge.js` - Consumes incoming telemetry to update graph weights and trigger route recomputation.
- [x] `backend/src/telemetry-encoder.js` - Compact fixed-size (19-byte) telemetry codec used by peer-local storage.
- [x] `backend/src/sim/path.js` - Path interpolation and speed estimation helpers for movement simulation.
- [x] `backend/src/storage/corestore.js` - Corestore bootstrap and helper API for append/read/close of telemetry Hypercore.
- [x] `backend/src/swarm/mesh.js` - Hyperswarm membership manager with topic rotation based on current H3 cell.
- [x] `backend/src/swarm/topic.js` - Derives geographic discovery topic via `h3 -> sha256`.

## Task 3 - Dijkstra Routing Module (`dijkstra`)

- [x] `dijkstra/README.md` - Routing submodule description (Spanish), architecture notes, and usage hints.
- [x] `dijkstra/package.json` - Local dependency manifest for routing/web demo module.
- [x] `dijkstra/package-lock.json` - Locked dependency graph for the dijkstra module.
- [x] `dijkstra/barcelona_streets.json` - Street network dataset used to build navigable graph nodes/edges.
- [x] `dijkstra/create_graph.js` - Builds H3-based navigable graph from street data for pathfinding.
- [x] `dijkstra/routing.js` - Route calculation + edge weight updates + route edge extraction helpers.
- [x] `dijkstra/schema.js` - Telemetry schema/constants used by routing/simulation encoding flow.
- [x] `dijkstra/simulation.js` - Simulation utilities that generate/move vehicles and produce routing telemetry.
- [x] `dijkstra/server.js` - Static server for the browser-side routing/P2P demo.
- [x] `dijkstra/routing.test.js` - Unit/integration coverage for route calculation and graph behavior.
- [x] `dijkstra/p2p.integration.test.js` - P2P integration validations around routing + telemetry propagation.

## Task 4 - Frontend (`public`)

- [x] `public/index.html` - Leaflet-based map shell, UI controls, and script entrypoint.
- [x] `public/app_p2p.js` - Main frontend runtime: renders peers/routes, exchanges control messages, and visualizes telemetry.
- [x] `public/app_p2p_backup.js` - Backup snapshot of frontend logic for rollback/reference.
- [x] `public/barcelona_streets.json` - Client-side copy of street graph data for map/routing visualization.

## Task 5 - Mock Scenario Tools (`examples/mock-directions`)

- [x] `examples/mock-directions/README.md` - Scenario execution guide and expected behavior checks.
- [x] `examples/mock-directions/run-scenario.js` - Runner that boots multiple mock cars with scenario-defined movement.
- [x] `examples/mock-directions/scenarios/same-cell.json` - Near-peers scenario where discovery/connectivity should happen.
- [x] `examples/mock-directions/scenarios/different-zones.json` - Distant-peers scenario where connectivity should be minimal.
- [x] `examples/mock-directions/scenarios/boundary-handoff.json` - Boundary crossing scenario to validate topic handoff continuity.
- [x] `examples/mock-directions/scenarios/churn-flapping.json` - Join/leave churn scenario to test resilience under flapping.
- [x] `examples/mock-directions/scenarios/message-ferry-chain.json` - Multi-hop chain scenario to validate store-carry-forward ferrying.

## Task 6 - Generated Runtime Data (Tracked Artifacts)

- [x] `backend/.data/**` (119 tracked files) - Runtime Corestore/DB state snapshots produced by local simulations and examples.

These files are generated state (logs, manifests, blobs, lock/session metadata, and CORESTORE pointers), not handwritten source code.
