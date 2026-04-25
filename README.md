# Place2Place

Peer-to-peer traffic simulation backend bootstrap for Pear/Bare.

## Backend bootstrap

This iteration scaffolds:

- Corestore + local telemetry Hypercore initialization
- Hyperswarm discovery with geographic H3-derived topics
- Mock GPS movement loop that rotates the discovery topic when the H3 cell changes

## Run

1. Install dependencies:
   - `npm install`
2. Start backend simulator:
   - `npm run backend:start`

The process logs each tick with current coordinate, speed estimate, H3 cell, and whether a topic rotation happened.

## P2P mock direction examples

Use example scenarios to validate local peer discovery behavior:

- `npm run example:mock:near` (cars in same zone, should connect)
- `npm run example:mock:far` (cars in distant zones, should not connect)

Additional docs live in `examples/mock-directions/README.md`.