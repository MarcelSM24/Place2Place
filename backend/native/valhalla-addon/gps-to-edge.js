'use strict'

const { spawnSync } = require('bare-subprocess')
const fs = require('bare-fs')
const path = require('bare-path')
const binding = require('./binding')

function toGraphIdString(edgeId64) {
  const raw = BigInt(edgeId64)
  const level = Number(raw & 0x7n)
  const tileId = Number((raw & 0x1fffff8n) >> 3n)
  const id = Number((raw & 0x3ffffe000000n) >> 25n)
  return `${level}/${tileId}/${id}`
}

function runWaysToEdges({
  configPath,
  valhallaWaysToEdgesBin
}) {
  const command = valhallaWaysToEdgesBin
  const args = ['--config', configPath]

  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : ''
    throw new Error(`valhalla_ways_to_edges failed: ${stderr}`)
  }
}

function loadWayEdgesIndex({
  tileDir
}) {
  const filePath = path.join(tileDir, 'way_edges.txt')
  const raw = fs.readFileSync(filePath, 'utf8')

  const map = new Map()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const parts = trimmed.split(',')
    if (parts.length < 3) continue

    const wayId = parts[0]
    const edges = []

    for (let i = 1; i + 1 < parts.length; i += 2) {
      const direction = Number(parts[i]) // 0 or 1
      const edgeId = parts[i + 1]
      edges.push({
        direction,
        edge_id: edgeId,
        edge_id_graph: toGraphIdString(edgeId)
      })
    }

    if (edges.length > 0) map.set(wayId, edges)
  }

  return map
}

function pickEdgeByDirection(edges, preferredDirection = 1) {
  if (!edges || edges.length === 0) return null
  const directional = edges.find((e) => e.direction === preferredDirection)
  return directional || edges[0]
}

function createGpsToEdgeAdapter({
  wayEdgesIndex,
  resolveOsmWayId
}) {
  if (!(wayEdgesIndex instanceof Map)) {
    throw new TypeError('wayEdgesIndex must be a Map returned by loadWayEdgesIndex')
  }
  if (typeof resolveOsmWayId !== 'function') {
    throw new TypeError('resolveOsmWayId(event) function is required')
  }

  return {
    async adaptTelemetry(event) {
      const resolved = await resolveOsmWayId(event)
      if (!resolved) return null

      const { osm_way_id, direction = 1 } = resolved
      if (!osm_way_id) return null

      const edges = wayEdgesIndex.get(String(osm_way_id))
      const selected = pickEdgeByDirection(edges, direction)
      if (!selected) return null

      return {
        edge_id: selected.edge_id,
        speed_kph: event.speed_kph ?? event.speed ?? 0
      }
    },

    async adaptBatch(events) {
      const out = []
      for (const event of events) {
        const mapped = await this.adaptTelemetry(event)
        if (mapped) out.push(mapped)
      }
      return out
    }
  }
}

function createWayEdgesReverseIndex(wayEdgesIndex) {
  const reverse = new Map()
  for (const [osmWayId, edges] of wayEdgesIndex.entries()) {
    for (const edge of edges) {
      reverse.set(edge.edge_id_graph, {
        osm_way_id: osmWayId,
        edge_id: edge.edge_id,
        direction: edge.direction
      })
    }
  }
  return reverse
}

function createValhallaLocateResolver({
  configPath,
  wayEdgesIndex
}) {
  if (!configPath) throw new Error('configPath is required')
  const reverseIndex = createWayEdgesReverseIndex(wayEdgesIndex)

  binding.initValhalla(configPath)

  return async function resolveOsmWayId(event) {
    const lat = Number(event.lat)
    const lon = Number(event.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

    const locateRequest = {
      verbose: true,
      locations: [{ lat, lon }]
    }

    const response = JSON.parse(binding.locate(locateRequest))
    const edges = Array.isArray(response) && response[0] && Array.isArray(response[0].edges)
      ? response[0].edges
      : []

    if (!edges || edges.length === 0) return null

    for (const edge of edges) {
      const edgeIdValue = edge.edge_id && typeof edge.edge_id.value !== 'undefined'
        ? String(edge.edge_id.value)
        : null

      const wayId = edge.edge_info && edge.edge_info.way_id
        ? String(edge.edge_info.way_id)
        : null

      if (wayId && wayEdgesIndex.has(wayId)) {
        const selected = pickEdgeByDirection(wayEdgesIndex.get(wayId), 1)
        if (selected) {
          return {
            osm_way_id: wayId,
            direction: selected.direction,
            edge_id: selected.edge_id
          }
        }
      }

      if (edgeIdValue) {
        const graphId = toGraphIdString(edgeIdValue)
        if (reverseIndex.has(graphId)) {
          const mapped = reverseIndex.get(graphId)
          return {
            osm_way_id: mapped.osm_way_id,
            direction: mapped.direction,
            edge_id: mapped.edge_id
          }
        }

        return {
          osm_way_id: wayId || null,
          direction: 1,
          edge_id: edgeIdValue
        }
      }
    }

    return null
  }
}

module.exports = {
  toGraphIdString,
  runWaysToEdges,
  loadWayEdgesIndex,
  createGpsToEdgeAdapter,
  createWayEdgesReverseIndex,
  createValhallaLocateResolver
}
