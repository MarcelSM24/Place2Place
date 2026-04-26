/**
 * Builds a navigable H3 graph from Barcelona OSM street geometry with directional edge rules.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import h3 from 'h3-js';
import createGraph from 'ngraph.graph';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const streetsPath = path.join(__dirname, 'barcelona_streets.json');
// 1. Cargar el JSON que bajaste de Overpass
const osmData = JSON.parse(fs.readFileSync(streetsPath, 'utf8'));
const RESOLUTION = 12; // ~170m de diámetro. Si quieres más precisión, usa 10 (~60m).

export function buildNavigableGraph() {
    const graph = createGraph();
    const processedHexes = new Set();
    let processedWays = 0;

    console.log("Procesando calles de Barcelona...");

    osmData.elements.forEach(element => {
        // 2. Filtrar explícitamente: solo ways con geometría
        if (element.type !== 'way' || !element.geometry) return;

        const isOneway = element.tags?.oneway === 'yes';
        let prevHex = null;
        processedWays++;

        element.geometry.forEach(point => {
            const currentHex = h3.latLngToCell(point.lat, point.lon, RESOLUTION);

            // Añadir el nodo al grafo si no existe
            if (!processedHexes.has(currentHex)) {
                graph.addNode(currentHex);
                processedHexes.add(currentHex);
            }

            // 3. Crear el link entre hexágono actual y el anterior
            if (prevHex && prevHex !== currentHex) {
                const dist = h3.greatCircleDistance(
                    h3.cellToLatLng(prevHex),
                    h3.cellToLatLng(currentHex),
                    'km'
                );

                // 4. Evitar links duplicados antes de añadir
                if (!graph.getLink(prevHex, currentHex)) {
                    graph.addLink(prevHex, currentHex, {
                        weight: dist,
                        baseWeight: dist,
                        edge_id: element.id
                    });
                }

                // 5. Respetar el sentido único: solo añadir la dirección inversa si no es oneway
                if (!isOneway && !graph.getLink(currentHex, prevHex)) {
                    graph.addLink(currentHex, prevHex, {
                        weight: dist,
                        baseWeight: dist,
                        edge_id: element.id
                    });
                }
            }

            prevHex = currentHex;
        });
    });

    //console.log(`Ways procesados: ${processedWays} de ${osmData.elements.length} elementos totales`);
    //console.log(`Grafo creado: ${graph.getNodeCount()} nodos y ${graph.getLinkCount()} calles.`);
    return { graph, validHexes: Array.from(processedHexes) };
}