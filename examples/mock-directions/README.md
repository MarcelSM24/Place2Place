# Mock Directions Examples

These scenarios help validate whether peer discovery behaves correctly with mocked car directions.

## Run commands

- Same area (cars should connect):
  - `npm run example:mock:near`
- Far apart (cars should mostly not connect):
  - `npm run example:mock:far`
- Custom scenario file:
  - `npm run example:mock -- ./examples/mock-directions/scenarios/same-cell.json`

## What to look for

- You should see `[mesh:<car-id>] connected peer=...` logs in the near scenario.
- You should see very few or no connection logs in the far scenario.
- Each car logs its current H3 cell and whether discovery topic rotated.

## Isolation behavior

Scenarios include a `topicNamespace` value. Topic derivation uses:

- `sha256("${topicNamespace}:${h3Cell}")`

This isolates example traffic from any other local/background peers not using the same namespace.
