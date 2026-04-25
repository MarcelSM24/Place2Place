#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

VALHALLA_BIN_DIR="${REPO_ROOT}/backend/native/valhalla-install/bin"
CONFIG_PATH="${REPO_ROOT}/backend/native/valhalla-addon/valhalla.json"
DATA_DIR="${REPO_ROOT}/backend/native/valhalla-data"

usage() {
  echo "Usage: $0 /absolute/path/to/region.osm.pbf"
  echo
  echo "Builds offline Valhalla datasets required by the native addon:"
  echo "  - tz_world.sqlite (timezones)"
  echo "  - admin.sqlite (administrative boundaries)"
  echo "  - routing tiles under ${DATA_DIR}/tiles"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  echo "Error: expected exactly 1 argument (path to .osm.pbf)."
  usage
  exit 1
fi

OSM_PBF="$1"

if [[ ! -f "${OSM_PBF}" ]]; then
  echo "Error: OSM extract not found: ${OSM_PBF}"
  exit 1
fi

for bin in valhalla_build_timezones valhalla_build_admins valhalla_build_tiles; do
  if [[ ! -x "${VALHALLA_BIN_DIR}/${bin}" ]]; then
    echo "Error: missing required executable: ${VALHALLA_BIN_DIR}/${bin}"
    echo "Build/install Valhalla first, then retry."
    exit 1
  fi
done

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "Error: config not found: ${CONFIG_PATH}"
  echo "Generate it first (already done in this project scaffold)."
  exit 1
fi

mkdir -p "${DATA_DIR}/tiles" "${DATA_DIR}/transit" "${DATA_DIR}/transit_feeds"

echo "[1/3] Building timezone database..."
"${VALHALLA_BIN_DIR}/valhalla_build_timezones" > "${DATA_DIR}/tz_world.sqlite"
echo "  Wrote ${DATA_DIR}/tz_world.sqlite"

echo "[2/3] Building admin database from ${OSM_PBF}..."
"${VALHALLA_BIN_DIR}/valhalla_build_admins" -c "${CONFIG_PATH}" "${OSM_PBF}"
echo "  Wrote ${DATA_DIR}/admin.sqlite"

echo "[3/3] Building routing tiles from ${OSM_PBF}..."
"${VALHALLA_BIN_DIR}/valhalla_build_tiles" -c "${CONFIG_PATH}" "${OSM_PBF}"
echo "  Updated tile graph at ${DATA_DIR}/tiles"

echo
echo "Valhalla offline data setup complete."
echo "Run smoke test:"
echo "  cd ${REPO_ROOT}/backend/native/valhalla-addon"
echo "  npx bare test.js ${CONFIG_PATH}"
