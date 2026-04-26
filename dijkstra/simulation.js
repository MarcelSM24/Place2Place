import h3 from 'h3-js';

export class Vehicle {
    constructor(id, startHex, route) {
        this.id = id;
        this.currentHex = startHex;
        this.route = route;
        this.position = 0;
        this.speed = 50;
        this.pendingStepMeters = 0;
        this.confidence = 100;
        this.flags = 0;
    }

    move() {
        // Convert km/h to progress in meters and map it to route steps.
        if (this.route && this.route.length > 0) {
            const lastIdx = this.route.length - 1;
            if (this.position < lastIdx) {
                // Random speed variation
                this.speed = Math.max(20, Math.min(100, this.speed + (Math.random() - 0.5) * 10));
                const metersPerSecond = this.speed / 3.6;
                this.pendingStepMeters += metersPerSecond; // tick is 1 second
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
            } else if (this.position === lastIdx) {
                // Reached destination, stop
                this.speed = 0;
                this.pendingStepMeters = 0;
            }
        }
    }

    getTelemetryEvent() {
        return {
            timestamp: Date.now(),
            edge_id: this.getCurrentEdgeId(),
            speed_kph: Math.min(255, Math.floor(this.speed || 0)),
            confidence: this.confidence,
            flags: this.flags
        };
    }

    getTelemetry() {
        const telemetry = this.getTelemetryEvent();
        // Manual Buffer encoding
        const buffer = Buffer.allocUnsafe(19);
        buffer.writeBigUInt64LE(BigInt(telemetry.timestamp), 0);
        buffer.writeBigUInt64LE(BigInt(telemetry.edge_id), 8);
        buffer.writeUInt8(telemetry.speed_kph, 16);
        buffer.writeUInt8(telemetry.confidence, 17);
        buffer.writeUInt8(telemetry.flags, 18);
        return buffer;
    }

    getCurrentEdgeId() {
        if (typeof this.currentHex !== 'string' || this.currentHex.length === 0) {
            return 0;
        }
        // Keep edge_id within Number.MAX_SAFE_INTEGER for shared telemetry encoder compatibility.
        const safeHex = this.currentHex.slice(-13);
        const id = Number.parseInt(safeHex, 16);
        return Number.isSafeInteger(id) && id >= 0 ? id : 0;
    }

    getLatLng() {
        return h3.cellToLatLng(this.currentHex);
    }
}

export function simulateVehicles(vehicles, onTelemetry) {
    console.log('[SIM] Vehicle simulation started (1 tick = 1 second, 1 step per tick)');
    let tick = 0;
    
    setInterval(() => {
        tick++;
        
        // Log every 5 seconds
        if (tick % 5 === 0) {
            console.log(`[SIM] Tick ${tick}s - vehicles moving...`);
        }

        vehicles.forEach(vehicle => {
            // Move vehicle
            const prevPos = vehicle.position;
            vehicle.move();

            // Send telemetry
            const telemetry = vehicle.getTelemetry();
            onTelemetry(vehicle.id, telemetry);

            // Log movement
            if (vehicle.position !== prevPos) {
                const [lat, lng] = vehicle.getLatLng();
                console.log(`[SIM] Vehicle ${vehicle.id}: ${prevPos} → ${vehicle.position} (hex=${vehicle.currentHex.slice(0, 8)}..., lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)})`);
            }
        });
    }, 1000);
}