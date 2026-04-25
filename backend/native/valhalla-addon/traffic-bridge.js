'use strict'

const binding = require('./binding')

function normalizeEdgeId(value) {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString()
  if (typeof value === 'string' && value.length > 0) return value
  throw new TypeError('telemetry.edge_id must be bigint, number, or non-empty string')
}

function normalizeSpeed(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed)) throw new TypeError('telemetry.speed_kph must be numeric')
  if (speed < 0) return 0
  if (speed > 255) return 255
  return Math.round(speed)
}

class TrafficTelemetryBridge {
  constructor({
    trafficTarPath,
    batchSize = 256,
    flushIntervalMs = 100,
    maxQueueSize = 10000,
    onError = null
  } = {}) {
    if (!trafficTarPath) throw new Error('trafficTarPath is required')

    this.trafficTarPath = trafficTarPath
    this.batchSize = batchSize
    this.flushIntervalMs = flushIntervalMs
    this.maxQueueSize = maxQueueSize
    this.onError = onError

    this.queue = []
    this.timer = null
    this.initialized = false
  }

  init() {
    if (this.initialized) return
    binding.initTrafficOverlay(this.trafficTarPath)
    this.initialized = true
  }

  start() {
    this.init()
    if (this.timer) return

    this.timer = setInterval(() => {
      try {
        this.flush()
      } catch (error) {
        this._handleError(error)
      }
    }, this.flushIntervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  ingestTelemetry(event) {
    if (!event) return

    const edgeId = normalizeEdgeId(event.edge_id ?? event.edgeId)
    const speedKph = normalizeSpeed(event.speed_kph ?? event.speedKph)

    if (this.queue.length >= this.maxQueueSize) {
      // Drop oldest to keep bounded memory and maintain real-time freshness.
      this.queue.shift()
    }

    this.queue.push({ edgeId, speedKph })

    if (this.queue.length >= this.batchSize) this.flush()
  }

  ingestTelemetryBatch(events) {
    if (!events || events.length === 0) return
    for (const event of events) this.ingestTelemetry(event)
  }

  flush() {
    if (this.queue.length === 0) return
    this.init()

    const batch = this.queue.splice(0, this.batchSize)
    for (const item of batch) {
      try {
        binding.updateTrafficSpeed(item.edgeId, item.speedKph)
      } catch (error) {
        this._handleError(error)
      }
    }
  }

  createAutobaseHandler() {
    return (event) => this.ingestTelemetry(event)
  }

  _handleError(error) {
    if (typeof this.onError === 'function') this.onError(error)
    else throw error
  }
}

module.exports = {
  TrafficTelemetryBridge
}
