export const SIMULATION_CONFIG = {
  tickMs: 1000,
  h3Resolution: 8,
  startPosition: {
    lat: 40.7128,
    lon: -74.006
  },
  // Waypoints around lower Manhattan to force occasional H3 cell changes.
  routeWaypoints: [
    { lat: 40.7128, lon: -74.006 },
    { lat: 40.7159, lon: -74.0027 },
    { lat: 40.719, lon: -73.9988 },
    { lat: 40.7223, lon: -73.9952 },
    { lat: 40.725, lon: -73.9996 },
    { lat: 40.7215, lon: -74.0043 },
    { lat: 40.7174, lon: -74.0081 },
    { lat: 40.714, lon: -74.0102 }
  ],
  interpolationStepsPerSegment: 10
};

export const STORAGE_CONFIG = {
  baseDirectory: "./backend/.data",
  telemetryCoreName: "telemetry-local"
};
