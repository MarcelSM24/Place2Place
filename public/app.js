const map = L.map('map').setView([41.387, 2.170], 15); // Más zoom, centrado en nueva posición

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

let vehicles = {};
let routeLayer = null;
let peerRouteLayers = {};
let originMarker = null; // Marcador de origen
let selectedOrigin = null; // { lat, lng }
const debugEl = document.getElementById('debug');
const statusEl = document.getElementById('status');
const btnSpawnMainVehicle = document.getElementById('btnSpawnMainVehicle');

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

ws.onopen = () => {
    updateStatus('Conectado al servidor');
    debugLog('WebSocket conectado');
};

ws.onclose = () => {
    updateStatus('Desconectado', 'red');
    debugLog('WebSocket desconectado');
};

ws.onerror = (event) => {
    updateStatus('Error de conexión', 'red');
    debugLog('WebSocket error: ' + event);
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    debugLog(`WS: ${data.type}`);

    if (data.type === 'init') {
        data.vehicles.forEach(v => {
            const isMain = v.id === 0;
            const marker = L.marker([v.lat, v.lng], {
                icon: L.icon({
                    iconUrl: isMain ? 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png' : 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
                    iconSize: [30, 45],
                    iconAnchor: [15, 45],
                    popupAnchor: [0, -45]
                })
            }).addTo(map);

            marker.bindPopup(`Vehículo ${v.id}${isMain ? ' (Principal)' : ''}<br>Pos: ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`);
            vehicles[v.id] = marker;
        });
        updateStatus(`${Object.keys(vehicles).length} vehículos inicializados`);
        debugLog(`Inicializados ${Object.keys(vehicles).length} vehículos`);
    } else if (data.type === 'route' || data.type === 'routeUpdate') {
        console.log('Received route data:', data.route);
        if (routeLayer) map.removeLayer(routeLayer);
        routeLayer = L.polyline(data.route, {
            color: data.type === 'routeUpdate' ? 'orange' : 'red',
            weight: 8,
            opacity: 1.0,
            dashArray: data.type === 'routeUpdate' ? '10, 10' : null
        }).addTo(map);

        if (data.type === 'route' && data.route.length > 1) {
            const bounds = routeLayer.getBounds();
            map.fitBounds(bounds, { padding: [20, 20] });
        }

        updateStatus(`Ruta ${data.type === 'routeUpdate' ? 'actualizada' : 'calculada'}: ${data.route.length} puntos`);
        debugLog(`Ruta ${data.type}: ${data.route.length} puntos`);
    } else if (data.type === 'peerRoute') {
        if (!Array.isArray(data.route) || data.route.length < 2) {
            return;
        }

        if (peerRouteLayers[data.id]) {
            map.removeLayer(peerRouteLayers[data.id]);
        }

        peerRouteLayers[data.id] = L.polyline(data.route, {
            color: 'blue',
            weight: 4,
            opacity: 0.7
        }).addTo(map);

        debugLog(`Ruta peer ${data.id}: ${data.route.length} puntos`);
    } else if (data.type === 'telemetry') {
        let marker = vehicles[data.id];
        if (!marker) {
            marker = L.marker([data.lat, data.lng], {
                icon: L.icon({
                    iconUrl: data.id === 0 ? 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png' : 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
                    iconSize: [30, 45],
                    iconAnchor: [15, 45],
                    popupAnchor: [0, -45]
                })
            }).addTo(map);
            marker.bindPopup(`Vehículo ${data.id}`);
            vehicles[data.id] = marker;
        }

        marker.setLatLng([data.lat, data.lng]);

        const speed = data.speed || 0;
        marker.setPopupContent(`Vehículo ${data.id}<br>Velocidad: ${Math.floor(speed)} km/h<br>Pos: ${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}<br>Índice: ${data.routeIndex}`);

        if (data.id === 0) {
            map.panTo([data.lat, data.lng]);
            console.log(`Vehicle 0 at ${data.lat}, ${data.lng}, index ${data.routeIndex}`);
        }

        debugLog(`Vehículo ${data.id} movido a ${data.lat.toFixed(5)}, ${data.lng.toFixed(5)} vel=${Math.floor(speed)} idx=${data.routeIndex}`);
    } else if (data.type === 'trafficJam') {
        updateStatus('⚠️ ' + data.message, 'orange');
        debugLog(`Atasco: ${data.message}`);
    } else if (data.type === 'error') {
        updateStatus('Error: ' + data.message, 'red');
        debugLog(`Error del servidor: ${data.message}`);
    }
};

map.on('click', (e) => {
    if (!selectedOrigin) {
        // Primer click: establecer origen
        selectedOrigin = { lat: e.latlng.lat, lng: e.latlng.lng };
        
        // Mostrar marcador de origen (amarillo)
        if (originMarker) map.removeLayer(originMarker);
        originMarker = L.marker([selectedOrigin.lat, selectedOrigin.lng], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-yellow.png',
                iconSize: [30, 45],
                iconAnchor: [15, 45],
                popupAnchor: [0, -45]
            })
        }).addTo(map);
        originMarker.bindPopup('Origen');
        
        updateStatus('Origen seleccionado. Haz click en el destino.', 'blue');
        debugLog(`Origen seleccionado: ${selectedOrigin.lat.toFixed(5)}, ${selectedOrigin.lng.toFixed(5)}`);
    } else {
        // Segundo click: establecer destino y calcular ruta
        const destination = { lat: e.latlng.lat, lng: e.latlng.lng };
        const origin = selectedOrigin; // Guardar antes de limpiar
        
        ws.send(JSON.stringify({
            type: 'setRoute',
            origin: origin,
            destination: destination
        }));
        
        // Limpiar origen para próximo viaje
        selectedOrigin = null;
        if (originMarker) map.removeLayer(originMarker);
        originMarker = null;
        
        updateStatus('Calculando ruta...', 'blue');
        debugLog(`Ruta solicitada: ${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)} → ${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)}`);
    }
});

const btnStressTest = document.getElementById('btnStressTest');
if (btnSpawnMainVehicle) {
    btnSpawnMainVehicle.addEventListener('click', () => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'spawnMainVehicle' }));
            updateStatus('Creando vehículo principal...', 'blue');
            debugLog('Botón Spawn Main Vehicle pulsado');
        }
    });
}

if (btnStressTest) {
    btnStressTest.addEventListener('click', () => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stressTest' }));
            updateStatus('Enviando evento de atasco...', 'orange');
            debugLog('Botón ¡Generar Atasco! pulsado');
        }
    });
}