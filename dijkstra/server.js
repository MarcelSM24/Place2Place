import h3 from 'h3-js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { calculateRoute, getHexFromLatLng, updateEdgeWeight } from './routing.js';
import { Vehicle, simulateVehicles } from './simulation.js';

const app = express();
const port = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

// Serve static files
app.use(express.static(publicDir));

// WebSocket server
const wss = new WebSocketServer({ port: 8080 });

let vehicles = [];
let mainVehicle = null;
let currentRoute = null;
let simulationStarted = false;
let currentDestination = null;
let mainRouteAssigned = false;

// Initialize vehicles at specific positions
function initVehicles() {
    const positions = [
        [41.387, 2.170], // Main vehicle
        [41.400, 2.190], // Secondary 1
        [41.370, 2.150], // Secondary 2
        [41.395, 2.165]  // Secondary 3
    ];

    positions.forEach((pos, i) => {
        const hex = getHexFromLatLng(pos[0], pos[1]);
        let route = [hex];

        // Assign random routes to ALL vehicles immediately (so they move from the start)
        let attempts = 0;
        while (attempts < 5) {
            try {
                const randomLat = 41.385 + (Math.random() - 0.5) * 0.04;
                const randomLng = 2.173 + (Math.random() - 0.5) * 0.04;
                const randomHex = getHexFromLatLng(randomLat, randomLng);
                const randomRoute = calculateRoute(hex, randomHex);
                if (randomRoute && randomRoute.length > 1) {
                    route = randomRoute;
                    console.log(`[INIT] Vehicle ${i} assigned random route: ${route.length} nodes`);
                    break;
                }
            } catch (e) {
                console.log(`[INIT] Vehicle ${i}: route attempt ${attempts + 1} failed: ${e.message}`);
            }
            attempts += 1;
        }

        if (route.length === 1) {
            console.log(`[INIT] Vehicle ${i}: kept stationary after ${attempts} attempts`);
        }

        const vehicle = new Vehicle(i, hex, route);
        vehicles.push(vehicle);
        console.log(`[INIT] Vehicle ${i} at hex ${hex}, route length=${route.length}`);
    });

    mainVehicle = vehicles[0];
    console.log(`[INIT] Main vehicle (0) initialized with route of ${mainVehicle.route.length} nodes`);
}

initVehicles();

// Start simulation immediately
if (!simulationStarted) {
    simulationStarted = true;
    console.log(`[START] Simulation starting...`);
    
    simulateVehicles(vehicles, (id, telemetry) => {
        const vehicle = vehicles.find(v => v.id === id);
        const [lat, lng] = vehicle.getLatLng();

        // For vehicle 0, only broadcast after the route has been assigned, so it doesn't appear too early
        if (id === 0 && !mainRouteAssigned) {
            return;
        }

        // Broadcast telemetry to all clients
        wss.clients.forEach(client => {
            if (client.readyState !== 1) return;
            client.send(JSON.stringify({
                type: 'telemetry',
                id,
                lat,
                lng,
                routeIndex: vehicle.position,
                speed: vehicle.speed,
                telemetry: Array.from(telemetry)
            }));
        });

        // Log movement for vehicle 0
        if (id === 0) {
            console.log(`[TELEMETRY] Vehicle 0: position=${vehicle.position}/${vehicle.route.length}, lat=${lat.toFixed(5)}, lng=${lng.toFixed(5)}`);
        }
    });
}

wss.on('connection', (ws) => {
    console.log(`[WS] Client connected. Broadcasting ${vehicles.length} vehicles.`);

    // Send initial vehicle positions for non-main vehicles only
    ws.send(JSON.stringify({
        type: 'init',
        vehicles: vehicles
            .filter(v => v.id !== 0)
            .map(v => ({
                id: v.id,
                lat: v.getLatLng()[0],
                lng: v.getLatLng()[1]
            }))
    }));

    ws.on('message', (message) => {
        const data = JSON.parse(message.toString());

        if (data.type === 'setRoute') {
            const { origin, destination } = data;
            console.log(`\n[ROUTE] Route requested: origin=(${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}) → destination=(${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)})`);

            // Recalculate using the vehicle's current hex as the origin if it's already moving
            const originHex = mainRouteAssigned ? mainVehicle.currentHex : getHexFromLatLng(origin.lat, origin.lng);
            const destHex = getHexFromLatLng(destination.lat, destination.lng);

            console.log(`[ROUTE] Calculating from hex=${originHex} to hex=${destHex}`);

            try {
                // Calculate route
                let routeNodes = calculateRoute(originHex, destHex);
                console.log(`[ROUTE] Raw route length: ${routeNodes.length} nodes`);
                
                currentRoute = routeNodes;
                console.log(`[ROUTE] ✓ Route finalized with ${currentRoute.length} nodes`);

                // Assign route to main vehicle - start from index 0
                mainVehicle.route = currentRoute;
                mainVehicle.position = 0;
                mainVehicle.currentHex = currentRoute[0];
                currentDestination = destHex;
                mainRouteAssigned = true;

                console.log(`[ROUTE] ✓ Vehicle 0: position=0/${currentRoute.length}`);

                // Broadcast route to frontend
                wss.clients.forEach(client => {
                    if (client.readyState !== 1) return;
                    client.send(JSON.stringify({
                        type: 'route',
                        route: currentRoute.map(hex => h3.cellToLatLng(hex))
                    }));
                });

            } catch (e) {
                console.error(`[ROUTE] ✗ Route error: ${e.message}`);
                ws.send(JSON.stringify({ type: 'error', message: 'No route found' }));
            }
        } else if (data.type === 'stressTest') {
            if (!mainRouteAssigned || !mainVehicle.route || mainVehicle.route.length < 3) {
                ws.send(JSON.stringify({ type: 'trafficJam', message: 'El vehículo necesita estar en movimiento para generar un atasco.' }));
                return;
            }

            const currentPosIdx = mainVehicle.position;
            const minAhead = 2; // Al menos 2 nodos por delante
            if (currentPosIdx + minAhead >= mainVehicle.route.length - 1) {
                ws.send(JSON.stringify({ type: 'trafficJam', message: 'El vehículo está muy cerca del destino, sin margen para atascos.' }));
                return;
            }

            // Pick a segment between 2 and 5 nodes ahead
            const maxAhead = Math.min(5, mainVehicle.route.length - currentPosIdx - 2);
            const aheadIdx = currentPosIdx + minAhead + Math.floor(Math.random() * maxAhead);
            
            const hexA = mainVehicle.route[aheadIdx];
            const hexB = mainVehicle.route[aheadIdx + 1];

            console.log(`\n[STRESS] Generando atasco entre ${hexA} y ${hexB}`);

            // Set infinite weight to block the path
            updateEdgeWeight(hexA, hexB, 999999);
            updateEdgeWeight(hexB, hexA, 999999);

            // Synthetic telemetry to clients
            wss.clients.forEach(client => {
                if (client.readyState !== 1) return;
                client.send(JSON.stringify({
                    type: 'trafficJam',
                    message: `¡ATASCO DETECTADO! Segmento bloqueado a ${aheadIdx - currentPosIdx} pasos de distancia.`
                }));
            });

            // Trigger Recalculation
            const originHex = mainVehicle.currentHex;
            const destHex = currentDestination;
            
            console.log(`[STRESS] Recalculando ruta para evitar el atasco...`);
            
            try {
                let routeNodes = calculateRoute(originHex, destHex);
                currentRoute = routeNodes;
                mainVehicle.route = currentRoute;
                mainVehicle.position = 0;
                
                wss.clients.forEach(client => {
                    if (client.readyState !== 1) return;
                    client.send(JSON.stringify({
                        type: 'routeUpdate',
                        route: currentRoute.map(hex => h3.cellToLatLng(hex))
                    }));
                });
                console.log(`[STRESS] ✓ Recálculo completado: ${currentRoute.length} nodos.`);
            } catch (e) {
                console.error(`[STRESS] ✗ Error recalculando ruta: ${e.message}`);
                wss.clients.forEach(client => {
                    client.send(JSON.stringify({ type: 'error', message: 'No hay ruta alternativa posible' }));
                });
            }
        }
    });
});

app.listen(port, () => {
    console.log(`\n[SERVER] Running at http://localhost:${port}`);
    console.log(`[SERVER] WebSocket on ws://localhost:8080\n`);
});