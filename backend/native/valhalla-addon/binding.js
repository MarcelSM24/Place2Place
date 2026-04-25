const native = require.addon()

module.exports = {
  initValhalla: native.initValhalla,
  initTrafficOverlay: native.initTrafficOverlay,
  calculateRoute(request) {
    const json = typeof request === 'string' ? request : JSON.stringify(request)
    return native.calculateRoute(json)
  },
  locate(request) {
    const json = typeof request === 'string' ? request : JSON.stringify(request)
    return native.locate(json)
  },
  updateTrafficSpeed(edgeId, speedKph) {
    const edgeIdString = typeof edgeId === 'bigint' ? edgeId.toString() : String(edgeId)
    const speed = Number(speedKph) & 0xff
    return native.updateTrafficSpeed(edgeIdString, speed)
  }
}
