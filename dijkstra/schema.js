import c from 'compact-encoding'

// Estructura oficial de 19 bytes definida en vuestro estudio de viabilidad
export const telemetryStruct = {
  encode (state, msg) {
    c.uint64.encode(state, msg.timestamp)
    c.uint64.encode(state, msg.edge_id)
    c.uint8.encode(state, msg.speed_kph)
    c.uint8.encode(state, msg.confidence)
    c.uint8.encode(state, msg.flags)
  },
  decode (state) {
    return {
      timestamp: c.uint64.decode(state),
      edge_id: c.uint64.decode(state),
      speed_kph: c.uint8.decode(state),
      confidence: c.uint8.decode(state),
      flags: c.uint8.decode(state)
    }
  }
}