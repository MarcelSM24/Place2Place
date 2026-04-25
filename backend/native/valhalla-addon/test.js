'use strict'

const binding = require('./binding')

const configPath = (globalThis.Bare && Bare.argv && Bare.argv[2]) || './valhalla.json'
const startLat = Number((globalThis.Bare && Bare.argv && Bare.argv[3]) || 42.7223)
const startLon = Number((globalThis.Bare && Bare.argv && Bare.argv[4]) || 1.8398)
const endLat = Number((globalThis.Bare && Bare.argv && Bare.argv[5]) || 42.5078)
const endLon = Number((globalThis.Bare && Bare.argv && Bare.argv[6]) || 1.5211)

binding.initValhalla(configPath)

const routeRequest = {
  locations: [
    { lat: startLat, lon: startLon },
    { lat: endLat, lon: endLon }
  ],
  costing: 'auto',
  directions_options: {
    units: 'kilometers'
  }
}

const routeResponse = binding.calculateRoute(routeRequest)

console.log('Valhalla route response:')
console.log(routeResponse)
