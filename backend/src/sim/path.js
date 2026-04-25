function interpolate(start, end, fraction) {
  return {
    lat: start.lat + (end.lat - start.lat) * fraction,
    lon: start.lon + (end.lon - start.lon) * fraction
  };
}

export function createPathGenerator({
  routeWaypoints,
  interpolationStepsPerSegment
}) {
  if (!routeWaypoints || routeWaypoints.length < 2) {
    throw new Error("routeWaypoints must contain at least two coordinates");
  }

  let segmentIndex = 0;
  let stepWithinSegment = 0;

  return () => {
    const from = routeWaypoints[segmentIndex];
    const to = routeWaypoints[(segmentIndex + 1) % routeWaypoints.length];
    const fraction = stepWithinSegment / interpolationStepsPerSegment;

    const point = interpolate(from, to, fraction);

    stepWithinSegment += 1;
    if (stepWithinSegment > interpolationStepsPerSegment) {
      stepWithinSegment = 0;
      segmentIndex = (segmentIndex + 1) % routeWaypoints.length;
    }

    return point;
  };
}

export function estimateSpeedKmh(previous, current, tickMs) {
  if (!previous) return 0;

  const latKm = 111.32 * (current.lat - previous.lat);
  const meanLatRadians = ((current.lat + previous.lat) / 2) * (Math.PI / 180);
  const lonKm = 111.32 * Math.cos(meanLatRadians) * (current.lon - previous.lon);
  const distanceKm = Math.sqrt(latKm * latKm + lonKm * lonKm);
  const hours = tickMs / (1000 * 60 * 60);

  return distanceKm / hours;
}
