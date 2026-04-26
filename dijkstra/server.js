import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

// Serve static files
// Now the server ONLY serves static files.
// All simulation, routing, and P2P communication happens in the browsers via PeerJS.
app.use(express.static(publicDir));

app.listen(port, () => {
    console.log(`\n[SERVER] Servidor Estático corriendo en http://localhost:${port}`);
    console.log(`[P2P] La red es puramente descentralizada (PeerJS WebRTC).`);
    console.log(`[P2P] Ya no se usan WebSockets centrales. Abre múltiples pestañas para ver a los peers descubrirse.\n`);
});