export const SIMULATION_CONFIG = {
  tickMs: 1000,
  h3Resolution: 12,
  startPosition: {
    lat: 41.387,
    lon: 2.17
  },
  // Waypoints around Barcelona so the dijkstra frontend view is aligned.
  routeWaypoints: [
    { lat: 41.387, lon: 2.17 },
    { lat: 41.3898, lon: 2.1752 },
    { lat: 41.3932, lon: 2.1805 },
    { lat: 41.3961, lon: 2.1841 },
    { lat: 41.3992, lon: 2.1789 },
    { lat: 41.3957, lon: 2.1731 },
    { lat: 41.3918, lon: 2.1687 },
    { lat: 41.3884, lon: 2.1654 }
  ],
  interpolationStepsPerSegment: 10
};

export const STORAGE_CONFIG = {
  baseDirectory: "./backend/.data",
  telemetryCoreName: "telemetry-local"
};
