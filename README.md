# Place2Place

Peer-to-peer traffic simulation backend bootstrap for Pear/Bare.

## Backend bootstrap

This iteration scaffolds:

- Corestore + local telemetry Hypercore initialization
- Hyperswarm discovery with geographic H3-derived topics
- Mock GPS movement loop that rotates the discovery topic when the H3 cell changes

## Dijkstra routing demo

The repository now also includes:

- `dijkstra/`: real-time route computation based on a street graph and Dijkstra/A*
- `public/`: frontend map UI that consumes route and telemetry updates over WebSocket

## Run

1. Install dependencies:
   - `npm install`
2. Start backend simulator:
   - `npm run backend:start`
3. Start routing + frontend demo:
   - `npm run routing:start`
   - open `http://localhost:3000`

The process logs each tick with current coordinate, speed estimate, H3 cell, and whether a topic rotation happened.

## P2P mock direction examples

Use example scenarios to validate local peer discovery behavior:

- `npm run example:mock:near` (cars in same zone, should connect)
- `npm run example:mock:far` (cars in distant zones, should not connect)

Additional docs live in `examples/mock-directions/README.md`.