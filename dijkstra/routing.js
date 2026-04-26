/**
 * Routing engine over the H3 graph: path calculation, edge lookups, and dynamic weight updates.
 */
import h3 from 'h3-js';
import { buildNavigableGraph } from './create_graph.js';
import path from 'ngraph.path';

let cachedGraph = null;
let validHexes = null;

function getGraph() {
    if (!cachedGraph) {
        const result = buildNavigableGraph();
        cachedGraph = result.graph;
        validHexes = result.validHexes;
    }
    return cachedGraph;
}

function snapToNearestValidHex(hex) {
    if (!validHexes) getGraph();
    if (cachedGraph.getNode(hex)) return hex;

    const [lat, lng] = h3.cellToLatLng(hex);
    let nearest = null;
    let minDist = Infinity;

    for (const validHex of validHexes) {
        const dist = h3.greatCircleDistance([lat, lng], h3.cellToLatLng(validHex), 'km');
        if (dist < minDist) {
            minDist = dist;
            nearest = validHex;
        }
    }
    console.log(`Snapped ${hex} to ${nearest} (dist: ${minDist.toFixed(3)} km)`);
    return nearest;
}

export function calculateRoute(startHex, endHex) {
    const graph = getGraph();
    startHex = snapToNearestValidHex(startHex);
    endHex = snapToNearestValidHex(endHex);

    console.log(`After snap: start=${startHex} end=${endHex}`);

    console.log(`Calculating route: start=${startHex} end=${endHex}`);

    if (startHex === endHex) {
        console.log('Start and end are the same hex, returning single point route');
        return [startHex];
    }

    const pathFinder = path.aStar(graph, {
        distance(fromNode, toNode, link) {
            return link.data.weight;
        },
        heuristic(fromNode, toNode) {
            // Heurística: distancia euclidiana entre hexágonos
            const [lat1, lng1] = h3.cellToLatLng(fromNode.id);
            const [lat2, lng2] = h3.cellToLatLng(toNode.id);
            return h3.greatCircleDistance([lat1, lng1], [lat2, lng2], 'km');
        }
    });

    const foundPath = pathFinder.find(startHex, endHex);
    if (!foundPath) {
        console.log('No path found between', startHex, 'and', endHex);
        throw new Error('No path found');
    }

    console.log(`Path found with ${foundPath.length} nodes`);
    // ngraph.path.find() returns the path from endNode to startNode. Reversing it so the destination is the last element.
    return foundPath.reverse().map(node => node.id);
}

export function getHexFromLatLng(lat, lng) {
    return h3.latLngToCell(lat, lng, 12); // Resolución 12 como en create_graph.js
}

export function getNavigableGraph() {
    return getGraph();
}

export function updateEdgeWeight(fromHex, toHex, weight) {
    const graph = getGraph();
    const link = graph.getLink(fromHex, toHex);
    if (link) {
        link.data.weight = weight;
        console.log(`Updated weight for ${fromHex} -> ${toHex} to ${weight}`);
    } else {
        console.log(`Could not find link ${fromHex} -> ${toHex} to update weight.`);
    }
}

export function updateEdgeWeightByEdgeId(edgeId, speedKph, options = {}) {
    const graph = getGraph();
    let updated = 0;
    const safeSpeed = Math.max(1, Number(speedKph) || 1);
    const baseFactor = Math.max(1, 60 / safeSpeed);
    const extraPenaltyMultiplier = Math.max(
        1,
        Number(options.extraPenaltyMultiplier) || 1
    );
    const factor = baseFactor * extraPenaltyMultiplier;

    graph.forEachLink((link) => {
        if (link.data?.edge_id !== edgeId) return;
        if (typeof link.data.baseWeight !== "number") {
            link.data.baseWeight = link.data.weight;
        }
        link.data.weight = link.data.baseWeight * factor;
        updated += 1;
    });

    return updated;
}

export function getEdgeIdForSegment(fromHex, toHex) {
    const graph = getGraph();
    const link = graph.getLink(fromHex, toHex);
    return link?.data?.edge_id ?? null;
}

export function getRouteEdgeIds(routeHexes) {
    const edgeIds = new Set();
    if (!Array.isArray(routeHexes) || routeHexes.length < 2) {
        return edgeIds;
    }

    for (let i = 0; i < routeHexes.length - 1; i++) {
        const edgeId = getEdgeIdForSegment(routeHexes[i], routeHexes[i + 1]);
        if (edgeId != null) {
            edgeIds.add(edgeId);
        }
    }

    return edgeIds;
}
