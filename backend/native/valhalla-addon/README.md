# Valhalla Bare Addon

Native Pear/Bare addon scaffold that exposes offline Valhalla routing to JavaScript via `require.addon()`.

## Files

- `binding.cc`: C++ addon entrypoint (`libjs` + `BARE_MODULE`)
- `binding.js`: JavaScript wrapper around native exports
- `CMakeLists.txt`: `bare-make` build configuration
- `test.js`: simple hardcoded route request smoke test

## Prerequisites

- Pear/Bare toolchain installed (including `bare-make`)
- A local Valhalla build/install (headers + libraries)
- A valid Valhalla config JSON (for example: `valhalla.json`)

## Build

Run from the addon directory:

```sh
cd /Users/marcelsm/Place2Place/backend/native/valhalla-addon
```

### 1) Generate + build with `VALHALLA_ROOT` (recommended)

Use this when Valhalla is installed under a single prefix containing `include/` and `lib/`.

```sh
npx bare-make generate --no-cache --define "VALHALLA_ROOT:PATH=/absolute/path/to/valhalla/install/prefix"
npx bare-make build
npx bare-make install
```

Example (Homebrew-style prefix on macOS):

```sh
npx bare-make generate --no-cache --define "VALHALLA_ROOT:PATH=/opt/homebrew/opt/valhalla"
npx bare-make build
npx bare-make install
```

### 2) Configure + build with explicit library path

Use this when the `libvalhalla` location is known but not in a standard linker path.

```sh
npx bare-make generate --no-cache --define "VALHALLA_LIBRARY:FILEPATH=/absolute/path/to/libvalhalla.a"
npx bare-make build
npx bare-make install
```

Linux example:

```sh
npx bare-make generate --no-cache --define "VALHALLA_LIBRARY:FILEPATH=/usr/local/lib/libvalhalla.so"
npx bare-make build
npx bare-make install
```

### 3) Build with default system linker paths

If Valhalla is already discoverable by your compiler/linker:

```sh
npx bare-make generate --no-cache
npx bare-make build
npx bare-make install
```

If you installed Valhalla into a local prefix and need `pkg-config` deps (common for static `libvalhalla.a`), use:

```sh
PKG_CONFIG_PATH="/absolute/path/to/valhalla-install/lib/pkgconfig:/opt/homebrew/lib/pkgconfig" \
  npx bare-make generate --no-cache \
  --define "VALHALLA_ROOT:PATH=/absolute/path/to/valhalla-install" \
  --define "VALHALLA_LIBRARY:FILEPATH=/absolute/path/to/valhalla-install/lib/libvalhalla.a"
PKG_CONFIG_PATH="/absolute/path/to/valhalla-install/lib/pkgconfig:/opt/homebrew/lib/pkgconfig" \
  npx bare-make build
npx bare-make install
```

## Data setup (offline routing)

A local config template is already generated at:

- `backend/native/valhalla-addon/valhalla.json`

It points to:

- `backend/native/valhalla-data/tiles`
- `backend/native/valhalla-data/admin.sqlite`
- `backend/native/valhalla-data/tz_world.sqlite`

Build those required datasets with:

```sh
cd /Users/marcelsm/Place2Place

# 1) Build timezone database
backend/native/valhalla-install/bin/valhalla_build_timezones > backend/native/valhalla-data/tz_world.sqlite

# 2) Build admins database from your OSM extract
backend/native/valhalla-install/bin/valhalla_build_admins \
  -c backend/native/valhalla-addon/valhalla.json \
  /absolute/path/to/region.osm.pbf

# 3) Build routing tiles from the same OSM extract
backend/native/valhalla-install/bin/valhalla_build_tiles \
  -c backend/native/valhalla-addon/valhalla.json \
  /absolute/path/to/region.osm.pbf
```

Or run the one-command helper script:

```sh
cd /Users/marcelsm/Place2Place
./backend/scripts/setup-valhalla-data.sh /absolute/path/to/region.osm.pbf
```

Quick checklist before running routes:

- `backend/native/valhalla-data/tz_world.sqlite` exists
- `backend/native/valhalla-data/admin.sqlite` exists
- `backend/native/valhalla-data/tiles` contains generated tile files

### Generate traffic.tar skeleton

After tiles are built, create `traffic.tar` (required for live speed injection) with:

```sh
cd /Users/marcelsm/Place2Place
backend/native/valhalla-install/bin/valhalla_build_extract \
  --config backend/native/valhalla-addon/valhalla.json \
  --with-traffic \
  --overwrite
```

Verify output:

```sh
ls -lh backend/native/valhalla-data/traffic.tar
```

## Run smoke test

Pass a config path as the first argument, then run the test script:

```sh
cd /Users/marcelsm/Place2Place/backend/native/valhalla-addon
npx bare test.js /absolute/path/to/valhalla.json
```

If no argument is provided, `test.js` defaults to:

```txt
./valhalla.json
```

## JavaScript usage

```js
const valhalla = require.addon()

valhalla.initValhalla('/absolute/path/to/valhalla.json')

const responseJson = valhalla.calculateRoute({
  locations: [
    { lat: 40.748817, lon: -73.985428 },
    { lat: 40.761432, lon: -73.977622 }
  ],
  costing: 'auto'
})
```

`calculateRoute(...)` accepts either:

- a JSON string request, or
- a plain JS object (auto-stringified before crossing into C++).

## Live traffic bridge (Autobase -> addon)

`traffic-bridge.js` batches telemetry updates and writes them into mmap'ed `traffic.tar`:

```js
const { TrafficTelemetryBridge } = require('./traffic-bridge')

const bridge = new TrafficTelemetryBridge({
  trafficTarPath: '/Users/marcelsm/Place2Place/backend/native/valhalla-data/traffic.tar',
  batchSize: 256,
  flushIntervalMs: 100
})

bridge.start()

// In your Autobase apply/stream handler:
bridge.ingestTelemetry({
  edge_id: 1234567890123456789n,
  speed_kph: 42
})
```

Telemetry event shape expected by the bridge:

- `edge_id` (string/number/bigint)
- `speed_kph` (0..255)

## Next step: map GPS -> edge_id

Current mock telemetry uses raw GPS. To feed the bridge, map GPS points to Valhalla edge ids:

1. Build `way_edges.txt` from your graph tiles:

```sh
cd /Users/marcelsm/Place2Place
backend/native/valhalla-install/bin/valhalla_ways_to_edges \
  --config backend/native/valhalla-addon/valhalla.json
```

This writes:

- `backend/native/valhalla-data/tiles/way_edges.txt`

2. Use `gps-to-edge.js` to load this mapping (`osm_way_id -> [edge_id...]`).
3. Resolve each GPS telemetry point to an `osm_way_id` (nearest-way snap step).
4. Convert snapped way to Valhalla edge id and emit `{ edge_id, speed_kph }`.
5. Feed mapped events into `TrafficTelemetryBridge`.

### `gps-to-edge.js` helper

```js
const {
  runWaysToEdges,
  loadWayEdgesIndex,
  createGpsToEdgeAdapter,
  createValhallaLocateResolver
} = require('./gps-to-edge')

runWaysToEdges({
  configPath: '/Users/marcelsm/Place2Place/backend/native/valhalla-addon/valhalla.json',
  valhallaWaysToEdgesBin: '/Users/marcelsm/Place2Place/backend/native/valhalla-install/bin/valhalla_ways_to_edges'
})

const wayEdgesIndex = loadWayEdgesIndex({
  tileDir: '/Users/marcelsm/Place2Place/backend/native/valhalla-data/tiles'
})

const resolveOsmWayId = createValhallaLocateResolver({
  configPath: '/Users/marcelsm/Place2Place/backend/native/valhalla-addon/valhalla.json',
  wayEdgesIndex
})

const adapter = createGpsToEdgeAdapter({
  wayEdgesIndex,
  resolveOsmWayId
})

const mapped = await adapter.adaptTelemetry({ lat: 42.7223, lon: 1.8398, speed_kph: 45 })
// => { edge_id: '...', speed_kph: 45 } from automatic locate + ways_to_edges mapping
```

