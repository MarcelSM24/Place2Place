# 🚗 Place2Place: Descentralizando la Navegación GPS Urbana

**Place2Place** es una aplicación de navegación GPS y simulación de tráfico **100% Peer-to-Peer (P2P)**. Elimina la necesidad de servidores centralizados gigantescos (como los de Google Maps o Waze) trasladando toda la inteligencia algorítmica directamente a los vehículos (*Edge Computing*).

Construido para el **HackUPC**, Place2Place demuestra que el futuro de las Smart Cities puede ser colaborativo, resistente a censuras, 100% privado y operado íntegramente por los propios ciudadanos.

---

## 🛑 El Problema Actual

Los sistemas de navegación y tráfico dominantes sufren de problemas fundamentales:
1. **Centralización Extrema:** Dependen de inmensas granjas de servidores que requieren una potencia de cálculo brutal para procesar los datos de millones de coches. Un fallo en sus servidores colapsa el sistema global.
2. **Invasión a la Privacidad:** Actúan como un "Gran Hermano". Los proveedores saben exactamente dónde estás, a dónde vas y qué rutas sueles tomar a diario, centralizando perfiles de movilidad extremadamente sensibles.
3. **Mantenimiento Costoso:** Procesar algoritmos de enrutamiento (Dijkstra/A*) para miles de peticiones por segundo en un backend central es financieramente insostenible sin monetizar los datos del usuario.

## 🌟 Nuestra Solución

**Place2Place** invierte el paradigma. La nube desaparece. En nuestro sistema:
- **No hay backend que calcule rutas:** Tu propio navegador web / app descarga el grafo estático de las calles y usa su CPU local para calcular la mejor ruta.
- **No hay backend de tráfico:** La congestión de tráfico se detecta de forma orgánica "chismorreando" (*Gossip Protocol*) con los coches que tienes alrededor.
- **Identidad Efímera:** Tus datos nunca viajan asociados a un ID persistente, preservando tu anonimato absoluto.

---

## ⚙️ Tecnologías Clave y Arquitectura

### 1. 🕸️ Red Epidémica y WebRTC (Gossip Protocol)
Utilizamos **PeerJS (WebRTC)** para establecer canales de datos P2P directos entre los navegadores. Los eventos de tráfico (frenazos, averías, densidad) se transmiten entre los nodos conectados mediante un protocolo Epidémico: tu coche le susurra a los coches más cercanos, y estos a los suyos, propagando la información de la ciudad a la velocidad de la luz sin saturar un servidor central.

### 2. 🧠 Inteligencia de Enjambre (Swarm AI)
Cada vehículo es un agente autónomo y egoísta. En lugar de recibir instrucciones desde arriba:
- El navegador rastrea la telemetría de sus pares cercanos.
- Si detecta que en una calle los vehículos vecinos circulan a **menos de 40 km/h**, aumenta dinámicamente el "coste temporal" de ese tramo en su propio mapa mental.
- Tras alterar su grafo local, lanza una búsqueda heurística **A* (A-Star)**. Si descubre que desviarse es un 15% más rápido, el sistema realiza una redirección preventiva (marcada visualmente en **magenta**).

### 3. 🔐 Privacidad Extrema y "Proof of Location"
*(Basado en nuestra integración modular de Holepunch/Pear)*
Utilizamos claves asimétricas **ed25519** efímeras que **rotan automáticamente cada 10 minutos** o cuando el vehículo cruza ciertos hexágonos geográficos (H3). Los coches atestiguan criptográficamente que hay un atasco para evitar spam (*Sybil resistance*), pero debido a la rotación constante, es imposible trazar el origen y el destino de un conductor a lo largo de un trayecto completo.

### 4. 🌍 Mapeo Hexagonal (Uber H3)
Para resolver la complejidad de encontrar pares cercanos en un globo terráqueo masivo, usamos el sistema de indexación espacial **H3**. Los canales de descubrimiento y los pesos dinámicos se clusterizan usando la resolución de red hexagonal, permitiendo búsquedas de proximidad $O(1)$ sin comprometer la latitud/longitud exacta.

---

## 🛠️ Cómo Probar la Simulación (Demo)

Hemos preparado una demostración visual interactiva donde los vehículos operan autónomamente y reaccionan al tráfico orgánicamente.

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Arranca el servidor local de estáticos:
   ```bash
   node dijkstra/server.js
   ```
3. Abre al menos **3 o 4 pestañas** en tu navegador en `http://localhost:3000`.
   - *Verás cómo cada pestaña instancia un coche diferente y se conectan en malla P2P.*
4. **Interactúa:**
   - Observa cómo si la densidad de coches azules aumenta en una calle y su velocidad cae, tu coche rojo automáticamente recalculará una **ruta alternativa en magenta**.
   - Haz clic en **⚠ Generar Coche Lento** para simular un "dominguero" a 20 km/h y observa cómo toda la red P2P entra en pánico, propaga el mensaje de "Atasco Fuerte", y todos los vehículos empiezan a callejear para evitar la zona colapsada de forma sincronizada, sin necesidad de un servidor central.

---

## 🔮 Conclusión
Place2Place demuestra que la inteligencia de una Smart City no necesita estar centralizada en manos privadas. Un sistema P2P guiado por **Inteligencia de Enjambre** resulta en un tráfico más optimizado, coste de infraestructura nulo y privacidad garantizada por defecto.

*Make routing sovereign again.*

---

## 📚 Documentación adicional

- Escenarios mock de descubrimiento P2P: `examples/mock-directions/README.md`
- Checklist de documentación por archivo: `docs/FILE_DOCUMENTATION.md`
