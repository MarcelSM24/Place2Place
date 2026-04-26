# Place2Place - P2P Navigation Demo

Una aplicación de navegación P2P similar a Waze para hackathon.

## Arquitectura

- **Backend**: Node.js con Express y WebSockets para comunicación en tiempo real.
- **Frontend**: HTML/JS con Leaflet para el mapa.
- **Grafo**: Basado en H3 para discretizar el espacio, usando datos de OpenStreetMap.
- **Rutas**: Algoritmo de Dijkstra con ngraph.path.
- **Simulación**: Vehículos simulados que envían telemetría.
- **P2P**: Gestionado por compañero usando holepunch-workshop.

## Archivos

- `create_graph.js`: Crea el grafo navegable a partir de datos OSM.
- `routing.js`: Calcula rutas con Dijkstra.
- `simulation.js`: Simula vehículos y telemetría.
- `server.js`: Servidor backend.
- `schema.js`: Esquema de telemetría.
- `public/index.html`: Interfaz web.
- `public/app.js`: Lógica del frontend.

## Instalación

1. Instalar dependencias: `npm install`
2. Ejecutar servidor: `node server.js`
3. Abrir `http://localhost:3000` en el navegador.

## Uso

- Los vehículos aparecen en el mapa (rojo: principal, azules: otros).
- Hacer clic en el mapa para establecer destino.
- Se calcula la ruta inicial y comienza la simulación.
- Los vehículos se mueven y envían telemetría (en consola por ahora).
- La ruta se recalcula si cambian las condiciones.

## Notas

- La red P2P se simula localmente; integrar con el workshop del compañero.
- Telemetría se envía como buffer codificado según schema.js.
- Para producción, integrar con mapas reales y GPS.