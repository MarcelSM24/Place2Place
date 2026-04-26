/**
 * Route adaptation bridge that translates traffic telemetry into live graph weight updates and reroutes.
 */
import {
  calculateRoute,
  getRouteEdgeIds,
  updateEdgeWeightByEdgeId
} from "../../dijkstra/routing.js";

/**
 * Connects incoming telemetry to local route maintenance.
 *
 * It updates edge weights from received traffic events and triggers rerouting
 * when a non-local event affects the currently active route.
 */
export class RoutingBridge {
  constructor({ onRouteUpdate }) {
    this.onRouteUpdate = onRouteUpdate;
    this.currentRoute = [];
    this.currentDestination = null;
    this.currentHex = null;
    this.currentRouteEdgeIds = new Set();
  }

  setActiveTrip({ route, destinationHex, currentHex }) {
    this.currentRoute = Array.isArray(route) ? route : [];
    this.currentDestination = destinationHex ?? null;
    this.currentHex = currentHex ?? this.currentRoute[0] ?? null;
    this.currentRouteEdgeIds = getRouteEdgeIds(this.currentRoute);
  }

  updateCurrentHex(currentHex) {
    this.currentHex = currentHex;
  }

  ingestTelemetry(event) {
    if (!event) return { rerouted: false, updatedLinks: 0 };

    const edgeId = Number(event.edge_id);
    const speedKph = Number(event.speed_kph);
    if (!Number.isFinite(edgeId)) return { rerouted: false, updatedLinks: 0 };
    const flags = Number(event.flags) || 0;
    const isLocalEvent = (flags & 1) === 1;
    const isSevereCongestion = !isLocalEvent && Number.isFinite(speedKph) && speedKph <= 8;
    const congestionPenalty = isSevereCongestion ? 25 : 1;

    const updatedLinks = updateEdgeWeightByEdgeId(edgeId, speedKph, {
      extraPenaltyMultiplier: congestionPenalty
    });
    const shouldReroute =
      updatedLinks > 0 &&
      this.currentDestination &&
      this.currentHex &&
      this.currentRouteEdgeIds.has(edgeId) &&
      !isLocalEvent;

    if (!shouldReroute) {
      return { rerouted: false, updatedLinks };
    }

    try {
      const nextRoute = calculateRoute(this.currentHex, this.currentDestination);
      this.currentRoute = nextRoute;
      this.currentRouteEdgeIds = getRouteEdgeIds(nextRoute);
      this.onRouteUpdate?.(nextRoute);
      return { rerouted: true, updatedLinks, route: nextRoute };
    } catch (error) {
      return { rerouted: false, updatedLinks, error };
    }
  }
}
