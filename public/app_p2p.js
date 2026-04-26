import * as h3 from 'https://esm.sh/h3-js@4.1.0';
import createGraph from 'https://esm.sh/ngraph.graph@20.1.2';
import * as path from 'https://esm.sh/ngraph.path@1.6.1';

const map = L.map('map').setView([41.387, 2.170], 15);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

const debugEl = document.getElementById('debug');
const statusEl = document.getElementById('status');
const btnStressTest = document.getElementById('btnStressTest');

function debugLog(message) {
    console.log(message);
    if (debugEl) {
        const time = new Date().toLocaleTimeString();
        debugEl.textContent = `${time} - ${message}\n${debugEl.textContent}`.slice(0, 2000);
    }
}

function updateStatus(message, color = 'green') {
    if (statusEl) {
        statusEl.textContent = message;
        statusEl.style.color = color;
    }
}

// ---------------------------
// 1. Graph Loading & Routing (Client Side)
// ---------------------------
let graph = createGraph();
let validHexes = [];
let graphLoaded = false;

async function loadGraph() {
    updateStatus('Cargando mapa P2P local (5MB)...', 'blue');
    try {
        const res = await fetch('barcelona_streets.json');
        const osmData = await res.json();

        const RESOLUTION = 12;
        const processedHexes = new Set();
        let ways = 0;

        osmData.elements.forEach(element => {
            if (element.type !== 'way' || !element.geometry) return;
            ways++;
            const isOneway = element.tags?.oneway === 'yes';
            let prevHex = null;

            element.geometry.forEach(point => {
                const currentHex = h3.latLngToCell(point.lat, point.lon, RESOLUTION);
                if (!processedHexes.has(currentHex)) {
                    graph.addNode(currentHex);
                    processedHexes.add(currentHex);
                }
                if (prevHex && prevHex !== currentHex) {
                    const dist = h3.greatCircleDistance(h3.cellToLatLng(prevHex), h3.cellToLatLng(currentHex), 'km');
                    if (!graph.getLink(prevHex, currentHex)) {
                        graph.addLink(prevHex, currentHex, { weight: dist, baseWeight: dist, edge_id: element.id });
                    }
                    if (!isOneway && !graph.getLink(currentHex, prevHex)) {
                        graph.addLink(currentHex, prevHex, { weight: dist, baseWeight: dist, edge_id: element.id });
                    }
                }
                prevHex = currentHex;
            });
        });
        validHexes = Array.from(processedHexes);
        graphLoaded = true;
        updateStatus(`Mapa cargado (${ways} calles). Listo para rutas locales.`, 'green');
        
        // Auto-spawn del vehículo al inicio para que haya actividad en el mapa
        spawnMyVehicle();
    } catch (e) {
        console.error(e);
        updateStatus('Error cargando mapa local', 'red');
    }
}
loadGraph();

function getHexFromLatLng(lat, lng) {
    return h3.latLngToCell(lat, lng, 12);
}

function snapToNearestValidHex(hex) {
    if (graph.getNode(hex)) return hex;
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
    return nearest || hex;
}

function calculateRoute(startHex, endHex) {
    startHex = snapToNearestValidHex(startHex);
    endHex = snapToNearestValidHex(endHex);

    if (startHex === endHex) return [startHex];

    const pathFinder = path.aStar(graph, {
        distance(fromNode, toNode, link) { return link.data.weight; },
        heuristic(fromNode, toNode) {
            const [lat1, lng1] = h3.cellToLatLng(fromNode.id);
            const [lat2, lng2] = h3.cellToLatLng(toNode.id);
            return h3.greatCircleDistance([lat1, lng1], [lat2, lng2], 'km');
        }
    });

    const foundPath = pathFinder.find(startHex, endHex);
    if (!foundPath) throw new Error('No path found');
    return foundPath.reverse().map(node => node.id);
}

function updateEdgeWeight(fromHex, toHex, weight) {
    const link = graph.getLink(fromHex, toHex);
    if (link) {
        link.data.weight = weight;
    }
    const revLink = graph.getLink(toHex, fromHex);
    if (revLink) {
        revLink.data.weight = weight;
    }
}

// ---------------------------
// 2. Local Simulation State
// ---------------------------
class Vehicle {
    constructor(id, startHex, route) {
        this.id = id;
        this.currentHex = startHex;
        this.route = route;
        this.position = 0;
        this.speed = 50;
        this.pendingStepMeters = 0;
    }
    move() {
        if (this.route && this.route.length > 0) {
            const lastIdx = this.route.length - 1;
            if (this.position < lastIdx) {
                if (this.isSlow) {
                    this.speed = 20; // Vehículo lento forzado
                } else {
                    // Comprobar si el segmento actual tiene tráfico pesado
                    const hexA = this.route[this.position];
                    const hexB = this.route[this.position + 1];
                    const link = graph.getLink(hexA, hexB) || graph.getLink(hexB, hexA);
                    
                    let isJam = link && link.data.weight > 1000;

                    if (isJam) {
                        this.speed = 20; // km/h (Atrapado en el atasco)
                    } else {
                        this.speed = Math.max(0, Math.min(50, this.speed + (Math.random() - 0.5) * 8));
                    }
                }

                const metersPerSecond = this.speed / 3.6;
                this.pendingStepMeters += metersPerSecond;
                const metersPerHexStep = 14;
                const stepCount = Math.min(
                    lastIdx - this.position,
                    Math.floor(this.pendingStepMeters / metersPerHexStep)
                );
                if (stepCount > 0) {
                    this.position += stepCount;
                    this.currentHex = this.route[this.position];
                    this.pendingStepMeters -= stepCount * metersPerHexStep;
                }
            } else {
                this.speed = 0;
            }
        }
    }
    getLatLng() {
        return h3.cellToLatLng(this.currentHex);
    }
}

let myVehicle = null;
let currentDestination = null;
let slowVehicles = [];
let peerStates = {}; // Estado local del resto del enjambre

// UI Variables
let vehiclesUI = {};
let routeLayer = null;
let peerRouteLayers = {};
let originMarker = null;
let selectedOrigin = null;

function updatePeerRoute(data) {
    if (peerRouteLayers[data.id]) {
        map.removeLayer(peerRouteLayers[data.id]);
    }
    peerRouteLayers[data.id] = L.polyline(data.route, {
        color: 'blue',
        weight: 4,
        opacity: 0.6,
        dashArray: '5, 5'
    }).addTo(map);
}

function updatePeerVehicle(data, isMain = false) {
    let marker = vehiclesUI[data.id];
    if (!marker) {
        marker = L.marker([data.lat, data.lng], {
            icon: L.icon({
                iconUrl: isMain ? 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png' : 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
                iconSize: [30, 45],
                iconAnchor: [15, 45],
                popupAnchor: [0, -45]
            })
        }).addTo(map);
        vehiclesUI[data.id] = marker;
    }
    marker.setLatLng([data.lat, data.lng]);
    const speed = data.speed || 0;
    marker.setPopupContent(`Vehículo ${data.id.substring(0, 8)}...<br>Vel: ${Math.floor(speed)} km/h<br>Idx: ${data.routeIndex}`);

    if (!isMain) {
        peerStates[data.id] = {
            hex: getHexFromLatLng(data.lat, data.lng),
            speed: speed,
            timestamp: Date.now()
        };
    }
}

// ---------------------------
// 3. Gossip & P2P Connectivity (PeerJS Topic Discovery)
// ---------------------------
const TOPIC_PREFIX = 'place2place-node-';
const MAX_NODES = 50;
let myNodeId = '';
let peer = null;
const connectedPeers = new Map();
const seenMessages = new Set();

function initPeer() {
    const tryId = TOPIC_PREFIX + Math.floor(Math.random() * MAX_NODES);
    const p = new Peer(tryId);

    p.on('open', (id) => {
        myNodeId = id;
        debugLog(`P2P Iniciado. Mi ID: ${id}`);
        updateStatus(`P2P Activo (${id})`, 'green');
        startDiscovery();
    });

    p.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            initPeer();
        } else if (err.type === 'peer-unavailable') {
            // Error esperado del "Discovery" a ciegas: el peer no existe. Lo silenciamos.
        } else {
            console.error(err);
        }
    });

    p.on('connection', setupConnection);
    return p;
}

function setupConnection(conn) {
    conn.on('open', () => {
        if (!connectedPeers.has(conn.peer)) {
            debugLog(`Conectado a peer: ${conn.peer}`);
            connectedPeers.set(conn.peer, conn);
            
            // Sincronizar mi ruta con el nuevo peer con un pequeño retraso para asegurar que el canal está listo
            if (myVehicle && myVehicle.route && myVehicle.route.length > 0) {
                setTimeout(() => {
                    if (conn.open) {
                        conn.send({
                            messageId: myNodeId + '-rsync-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                            type: 'peerRoute',
                            data: { id: myNodeId, route: myVehicle.route.map(h => h3.cellToLatLng(h)) }
                        });
                    }
                }, 500);
            }
        }
    });
    conn.on('data', handleP2PMessage);
    conn.on('close', () => {
        connectedPeers.delete(conn.peer);
        debugLog(`Desconectado de: ${conn.peer}`);
    });
    conn.on('error', () => connectedPeers.delete(conn.peer));
}

const MAX_PEERS = 5; // Evitar una malla completa (Full Mesh) para no saturar con el Gossip

function startDiscovery() {
    setInterval(() => {
        // Solo descubrimos si no hemos alcanzado nuestro límite ideal de peers
        if (connectedPeers.size < MAX_PEERS) {
            // Probamos 3 IDs al azar en lugar de bombardear todos los IDs
            for (let i = 0; i < 3; i++) {
                const targetId = TOPIC_PREFIX + Math.floor(Math.random() * MAX_NODES);
                if (targetId !== myNodeId && !connectedPeers.has(targetId)) {
                    const conn = peer.connect(targetId, { reliable: true });
                    setupConnection(conn);
                }
            }
        }
    }, 4000);
}

// Start P2P
peer = initPeer();

function broadcast(message) {
    if (!message.messageId) {
        message.messageId = myNodeId + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }
    seenMessages.add(message.messageId);

    for (const conn of connectedPeers.values()) {
        if (conn.open) {
            conn.send(message);
        }
    }
}

function handleP2PMessage(message) {
    if (!message || !message.messageId || seenMessages.has(message.messageId)) return;
    seenMessages.add(message.messageId);

    // Propagación Epidémica (Retransmitir)
    for (const conn of connectedPeers.values()) {
        if (conn.open) {
            conn.send(message);
        }
    }

    // Procesar estado
    if (message.type === 'telemetry') {
        updatePeerVehicle(message.data);
        const d = message.data;
        const shortId = d.id.substring(d.id.length - 4);
        debugLog(`[TEL] Peer-${shortId} | Lat:${d.lat.toFixed(4)} Lng:${d.lng.toFixed(4)} | ${Math.floor(d.speed)}km/h`);
    } else if (message.type === 'trafficJam') {
        handleTrafficJam(message.data);
        const state = message.data.penalty > 1000 ? 'BLOCKED' : 'CLEAR';
        debugLog(`[JAM] Tramo ${message.data.hexA.substring(0,5)}... -> ${state}`);
    } else if (message.type === 'peerRoute') {
        updatePeerRoute(message.data);
        const shortId = message.data.id.substring(message.data.id.length - 4);
        debugLog(`[ROUTE] Sincronizada ruta de Peer-${shortId}`);
    }
}

// ---------------------------
// 4. Interaction & Logic
// ---------------------------

map.on('click', (e) => {
    if (!graphLoaded) return updateStatus('Espera a que cargue el mapa', 'orange');

    if (!selectedOrigin) {
        // If we have a myVehicle we can use it directly, but let's allow setting it manually if no myVehicle.
        if (myVehicle) {
            selectedOrigin = { lat: myVehicle.getLatLng()[0], lng: myVehicle.getLatLng()[1] };
            // Auto continue to destination
            const destination = { lat: e.latlng.lat, lng: e.latlng.lng };
            calculateAndAssignRoute(selectedOrigin, destination);
            selectedOrigin = null;
        } else {
            selectedOrigin = { lat: e.latlng.lat, lng: e.latlng.lng };
            if (originMarker) map.removeLayer(originMarker);
            originMarker = L.marker([selectedOrigin.lat, selectedOrigin.lng], {
                icon: L.icon({
                    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-yellow.png',
                    iconSize: [30, 45],
                    iconAnchor: [15, 45]
                })
            }).addTo(map);
            updateStatus('Origen marcado. Click para destino.', 'blue');
        }
    } else {
        const destination = { lat: e.latlng.lat, lng: e.latlng.lng };
        calculateAndAssignRoute(selectedOrigin, destination);

        selectedOrigin = null;
        if (originMarker) map.removeLayer(originMarker);
    }
});

function calculateAndAssignRoute(origin, destination) {
    const originHex = getHexFromLatLng(origin.lat, origin.lng);
    const destHex = getHexFromLatLng(destination.lat, destination.lng);

    try {
        updateStatus('Calculando ruta localmente...', 'blue');
        const routeHexes = calculateRoute(originHex, destHex);

        if (!myVehicle) {
            myVehicle = new Vehicle(myNodeId, routeHexes[0], routeHexes);
        } else {
            myVehicle.currentHex = routeHexes[0];
            myVehicle.route = routeHexes;
            myVehicle.position = 0;
            myVehicle.isWaiting = false;
        }
        currentDestination = destHex;

        if (routeLayer) map.removeLayer(routeLayer);
        const routeLatLngs = routeHexes.map(h => h3.cellToLatLng(h));
        routeLayer = L.polyline(routeLatLngs, { color: 'red', weight: 8 }).addTo(map);

        broadcast({
            type: 'peerRoute',
            data: { id: myNodeId, route: routeLatLngs }
        });

        updateStatus(`Ruta calculada: ${routeHexes.length} puntos.`, 'green');

    } catch (err) {
        console.error(err);
        updateStatus('Error al calcular ruta', 'red');
    }
}

function spawnMyVehicle() {
    if (!graphLoaded || myVehicle) return;
    
    // Área moderadamente acotada para favorecer atascos
    const centerLat = 41.387 + (Math.random() - 0.5) * 0.015;
    const centerLng = 2.170 + (Math.random() - 0.5) * 0.015;
    
    const randomLat = 41.387 + (Math.random() - 0.5) * 0.015;
    const randomLng = 2.170 + (Math.random() - 0.5) * 0.015;
    
    const startHex = snapToNearestValidHex(getHexFromLatLng(centerLat, centerLng));
    const destHex = snapToNearestValidHex(getHexFromLatLng(randomLat, randomLng));
    
    try {
        const route = calculateRoute(startHex, destHex);
        myVehicle = new Vehicle(myNodeId, startHex, route);
        currentDestination = destHex;
        
        if (routeLayer) map.removeLayer(routeLayer);
        const routeLatLngs = route.map(h => h3.cellToLatLng(h));
        routeLayer = L.polyline(routeLatLngs, { color: 'red', weight: 8 }).addTo(map);
        
        broadcast({
            type: 'peerRoute',
            data: { id: myNodeId, route: routeLatLngs }
        });
        
        updateStatus('Vehículo auto-iniciado con ruta aleatoria. Click en el mapa para redirigir.', 'blue');
    } catch(e) {
        myVehicle = new Vehicle(myNodeId, startHex, [startHex]);
        updateStatus('Vehículo estático iniciado. Click en el mapa para navegar.', 'blue');
    }
}

// Removed btnSpawnMainVehicle listener

if (btnStressTest) {
    btnStressTest.addEventListener('click', () => {
        if (!myVehicle || !myVehicle.route) return;

        const remainingSteps = myVehicle.route.length - myVehicle.position;
        if (remainingSteps < 10) {
            return updateStatus('Necesitas una ruta más larga para generar tráfico (mínimo 10 pasos restantes).', 'orange');
        }

        // Generar el coche aleatoriamente entre el 25% y el 75% del trayecto que nos queda por delante
        // Así no sale ni pegado a nosotros ni pegado a la meta.
        const minAhead = Math.floor(remainingSteps * 0.25);
        const maxAhead = Math.floor(remainingSteps * 0.75);
        const randomOffset = minAhead + Math.floor(Math.random() * (maxAhead - minAhead));
        const aheadIdx = myVehicle.position + randomOffset;
        
        const spawnHex = myVehicle.route[aheadIdx];
        const slowRoute = myVehicle.route.slice(aheadIdx); // Mismo destino

        const slowId = myNodeId + '-slow-' + Date.now().toString().substr(-4);
        const slowV = new Vehicle(slowId, spawnHex, slowRoute);
        slowV.isSlow = true;
        slowVehicles.push(slowV);
        
        // Bloquear segmento inicial del coche lento
        const hexA = slowRoute[0];
        const hexB = slowRoute[Math.min(1, slowRoute.length - 1)];
        if (hexA !== hexB) {
            const jamData = { hexA, hexB, penalty: 999999 };
            broadcast({ type: 'trafficJam', data: jamData });
            handleTrafficJam(jamData);
        }

        updateStatus(`Coche lento soltado por delante para forzar recálculo.`, 'orange');
    });
}

function handleTrafficJam({ hexA, hexB, penalty }) {
    const isClear = penalty < 1000;
    updateStatus(isClear ? 'Vía despejada. Actualizando grafo.' : '¡Atasco móvil! Actualizando pesos.', isClear ? 'green' : 'orange');
    
    // Actualizar el peso de la arista en el grafo local
    const link = graph.getLink(hexA, hexB);
    if (link) link.data.weight = penalty;
    const revLink = graph.getLink(hexB, hexA);
    if (revLink) revLink.data.weight = penalty;

    // Solo recalculo si el atasco interfiere con mi ruta por recorrer
    if (myVehicle && currentDestination && myVehicle.route) {
        const remainingRoute = myVehicle.route.slice(myVehicle.position);
        const isAffected = remainingRoute.includes(hexA) || remainingRoute.includes(hexB);
        
        if (isAffected) {
            try {
                const newRoute = calculateRoute(myVehicle.currentHex, currentDestination);
                const stillAffected = newRoute.includes(hexA) && newRoute.includes(hexB);
                
                myVehicle.route = newRoute;
                myVehicle.position = 0;

                if (routeLayer) map.removeLayer(routeLayer);
                const routeLatLngs = newRoute.map(h => h3.cellToLatLng(h));
                
                if (stillAffected && !isClear) {
                    routeLayer = L.polyline(routeLatLngs, { color: 'darkred', weight: 8, dashArray: '20, 20' }).addTo(map);
                    updateStatus('Atrapado tras coche lento. Sin ruta alternativa.', 'red');
                } else {
                    routeLayer = L.polyline(routeLatLngs, { color: isClear ? 'red' : 'orange', weight: 8, dashArray: isClear ? null : '10, 10' }).addTo(map);
                    updateStatus(isClear ? 'Ruta óptima restaurada.' : 'Ruta recalculada evadiendo coche lento.', 'green');
                }
                
                broadcast({
                    type: 'peerRoute',
                    data: { id: myNodeId, route: routeLatLngs }
                });
            } catch (e) {
                console.error(e);
            }
        }
    }
}

// Simulador Loop
setInterval(() => {
    if (myVehicle && myVehicle.route && myVehicle.route.length > 0) {
        myVehicle.move();
        const [lat, lng] = myVehicle.getLatLng();

        const msg = {
            id: myNodeId,
            lat, lng,
            speed: myVehicle.speed,
            routeIndex: myVehicle.position
        };

        updatePeerVehicle(msg, true);
        broadcast({ type: 'telemetry', data: msg });

        // Procesar coches lentos generados localmente
        slowVehicles.forEach(sv => {
            const prevPos = sv.position;
            sv.move();
            
            const [slat, slng] = sv.getLatLng();
            const sMsg = {
                id: sv.id,
                lat: slat, lng: slng,
                speed: sv.speed,
                routeIndex: sv.position
            };
            updatePeerVehicle(sMsg, false);
            broadcast({ type: 'telemetry', data: sMsg });

            // Si el coche lento avanzó de segmento, mueve el atasco
            if (sv.position !== prevPos) {
                // Restaurar el tramo viejo
                if (prevPos < sv.route.length - 1) {
                    const oldHexA = sv.route[prevPos];
                    const oldHexB = sv.route[prevPos + 1];
                    const dist = h3.greatCircleDistance(h3.cellToLatLng(oldHexA), h3.cellToLatLng(oldHexB), 'km');
                    const restoreData = { hexA: oldHexA, hexB: oldHexB, penalty: dist };
                    broadcast({ type: 'trafficJam', data: restoreData });
                    handleTrafficJam(restoreData);
                }
                
                // Bloquear el nuevo tramo
                if (sv.position < sv.route.length - 1) {
                    const newHexA = sv.route[sv.position];
                    const newHexB = sv.route[sv.position + 1];
                    const jamData = { hexA: newHexA, hexB: newHexB, penalty: 999999 };
                    broadcast({ type: 'trafficJam', data: jamData });
                    handleTrafficJam(jamData);
                }
            }
        });
        
        // Limpiar coches lentos que hayan llegado a su destino
        slowVehicles = slowVehicles.filter(sv => sv.position < sv.route.length - 1);

        // Auto-rutear cuando llegamos al destino
        const lastIdx = myVehicle.route.length - 1;
        if (myVehicle.position >= lastIdx && !myVehicle.isWaiting) {
            myVehicle.isWaiting = true;
            updateStatus('Destino alcanzado. Esperando 2s...', 'blue');
            
            setTimeout(() => {
                if (!myVehicle || !myVehicle.isWaiting) return; // Por si el usuario hizo click a mano mientras esperaba
                
                // Generar nueva ruta aleatoria en área moderada
                const randomLat = 41.387 + (Math.random() - 0.5) * 0.015;
                const randomLng = 2.170 + (Math.random() - 0.5) * 0.015;
                const destHex = snapToNearestValidHex(getHexFromLatLng(randomLat, randomLng));
                
                try {
                    const newRoute = calculateRoute(myVehicle.currentHex, destHex);
                    myVehicle.route = newRoute;
                    myVehicle.position = 0;
                    myVehicle.isWaiting = false;
                    currentDestination = destHex;
                    
                    if (routeLayer) map.removeLayer(routeLayer);
                    const routeLatLngs = newRoute.map(h => h3.cellToLatLng(h));
                    routeLayer = L.polyline(routeLatLngs, { color: 'red', weight: 8 }).addTo(map);
                    
                    broadcast({
                        type: 'peerRoute',
                        data: { id: myNodeId, route: routeLatLngs }
                    });
                    updateStatus('Iniciando nueva ruta aleatoria.', 'green');
                } catch (e) {
                    // Si no encuentra ruta, que lo vuelva a intentar en el siguiente tick
                    myVehicle.isWaiting = false;
                }
            }, 2000);
        }
    }
}, 1000);

// Inteligencia de Enjambre (Dynamic Congestion)
function applyDynamicTraffic() {
    if (!graphLoaded) return;

    // 1. Restaurar todos los pesos base, exceptuando los bloqueos manuales (999999)
    graph.forEachLink(link => {
        if (link.data.weight < 900000 && link.data.baseWeight) {
            link.data.weight = link.data.baseWeight;
        }
    });

    // 2. Contar densidad de vehículos P2P por hexágono
    const hexTraffic = {};
    const now = Date.now();
    for (const pid in peerStates) {
        const state = peerStates[pid];
        if (now - state.timestamp < 6000) { // Vehículos recientes
            // Lógica exagerada solicitada: Si el coche va a menos de 40 km/h, se considera ATASCO
            if (state.speed < 40) {
                hexTraffic[state.hex] = (hexTraffic[state.hex] || 0) + 1;
            }
        }
    }

    // 3. Aplicar penalizaciones dinámicas EXAGERADAS
    let hasCongestion = false;
    for (const hex in hexTraffic) {
        const count = hexTraffic[hex];
        let extraCost = 0;
        
        // Si hay al menos un coche a menos de 40km/h, ponemos 50 km de penalización (Evitar a toda costa)
        if (count >= 1) extraCost = 50.0;

        if (extraCost > 0) {
            hasCongestion = true;
            const node = graph.getNode(hex);
            if (node && node.links) {
                node.links.forEach(link => {
                    if (link.data.weight < 900000) {
                        link.data.weight += extraCost;
                    }
                });
            }
        }
    }

    // 4. Recálculo preventivo si nuestro camino actual es subóptimo
    if (hasCongestion && myVehicle && myVehicle.route && currentDestination && !myVehicle.isWaiting) {
        const remainingSteps = myVehicle.route.length - myVehicle.position;
        if (remainingSteps > 3) {
            let currentCost = 0;
            for (let i = myVehicle.position; i < myVehicle.route.length - 1; i++) {
                const link = graph.getLink(myVehicle.route[i], myVehicle.route[i+1]);
                if (link) currentCost += link.data.weight;
            }

            try {
                // Buscamos ruta con el grafo recién penalizado
                const pathFinder = path.aStar(graph, {
                    distance(fromNode, toNode, link) { return link.data.weight; },
                    heuristic(fromNode, toNode) {
                        const [lat1, lng1] = h3.cellToLatLng(fromNode.id);
                        const [lat2, lng2] = h3.cellToLatLng(toNode.id);
                        return h3.greatCircleDistance([lat1, lng1], [lat2, lng2], 'km');
                    }
                });

                const altPathNodes = pathFinder.find(myVehicle.currentHex, currentDestination);
                if (altPathNodes && altPathNodes.length > 0) {
                    altPathNodes.reverse();
                    let altCost = 0;
                    for (let i = 0; i < altPathNodes.length - 1; i++) {
                        const link = graph.getLink(altPathNodes[i].id, altPathNodes[i+1].id);
                        if (link) altCost += link.data.weight;
                    }

                    // Si la alternativa es un 15% más rápida, nos desviamos
                    if (altCost < currentCost * 0.85) {
                        const newRoute = altPathNodes.map(n => n.id);
                        myVehicle.route = newRoute;
                        myVehicle.position = 0;
                        
                        if (routeLayer) map.removeLayer(routeLayer);
                        const routeLatLngs = newRoute.map(h => h3.cellToLatLng(h));
                        routeLayer = L.polyline(routeLatLngs, { color: '#ff00ff', weight: 8, dashArray: '10, 15' }).addTo(map);
                        
                        broadcast({
                            type: 'peerRoute',
                            data: { id: myNodeId, route: routeLatLngs }
                        });
                        
                        updateStatus('Desvío automático: Tráfico pesado detectado.', '#ff00ff');
                        debugLog(`[AI] Redirección P2P: Coste original ${currentCost.toFixed(2)} -> Nuevo ${altCost.toFixed(2)}`);
                    }
                }
            } catch (e) {
                // Ignorar si no hay ruta alternativa válida
            }
        }
    }
}

// Evaluar la congestión dinámica cada 3 segundos
setInterval(applyDynamicTraffic, 3000);