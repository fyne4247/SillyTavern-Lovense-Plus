/**
 * Intiface Central transport: Buttplug protocol v3 over a WebSocket, straight
 * from the browser. Works with any toy Intiface supports, not just Lovense.
 */
import { CHANNELS } from '../channels.js';

const CLIENT_NAME = 'SillyTavern Lovense';
const REQUEST_TIMEOUT_MS = 5000;

// Buttplug ScalarCmd actuator types -> our channel names.
const SCALAR_CHANNELS = {
    Vibrate: 'vibrate',
    Rotate: 'rotate',
    Oscillate: 'oscillate',
    Constrict: 'pump',
    Inflate: 'pump',
};

/**
 * Turn a Buttplug v3 device record into our device shape plus the outputs
 * needed to drive it.
 * @param {object} raw DeviceAdded / DeviceList entry
 */
export function parseDevice(raw) {
    const messages = raw.DeviceMessages || {};
    const outputs = [];
    let vibrators = 0;

    for (const [index, feature] of (messages.ScalarCmd || []).entries()) {
        const type = feature.ActuatorType;
        let channel = SCALAR_CHANNELS[type];
        if (!channel) continue;
        if (channel === 'vibrate') {
            // First motor is `vibrate`, every other motor follows `vibrate2`.
            channel = vibrators++ === 0 ? 'vibrate' : 'vibrate2';
        }
        outputs.push({ kind: 'scalar', channel, index, actuatorType: type, steps: Number(feature.StepCount) || 20 });
    }
    for (const [index, feature] of (messages.RotateCmd || []).entries()) {
        outputs.push({ kind: 'rotate', channel: 'rotate', index, steps: Number(feature.StepCount) || 20 });
    }
    for (const [index] of (messages.LinearCmd || []).entries()) {
        outputs.push({ kind: 'linear', channel: 'thrust', index });
    }

    const channels = [...new Set(outputs.map((o) => o.channel))];
    return {
        id: String(raw.DeviceIndex),
        index: raw.DeviceIndex,
        name: raw.DeviceDisplayName || raw.DeviceName || `Device ${raw.DeviceIndex}`,
        channels,
        outputs,
        battery: null,
    };
}

/**
 * Build the Buttplug messages for one set of channel values on one device.
 * Linear (stroker) outputs are handled separately by the stroke loop.
 * @returns {Array<[string, object]>} [messageType, fields] pairs
 */
export function buildCommands(device, values) {
    const scalars = [];
    const rotations = [];
    for (const out of device.outputs) {
        if (!(out.channel in values)) continue;
        const level = values[out.channel] / CHANNELS[out.channel];
        if (out.kind === 'scalar') {
            scalars.push({ Index: out.index, Scalar: Math.min(1, Math.max(0, level)), ActuatorType: out.actuatorType });
        } else if (out.kind === 'rotate') {
            rotations.push({ Index: out.index, Speed: Math.min(1, Math.max(0, level)), Clockwise: true });
        }
    }
    const commands = [];
    if (scalars.length) commands.push(['ScalarCmd', { DeviceIndex: device.index, Scalars: scalars }]);
    if (rotations.length) commands.push(['RotateCmd', { DeviceIndex: device.index, Rotations: rotations }]);
    return commands;
}

/** Thrust speed 1-20 -> milliseconds per half-stroke. */
export function strokeDuration(speed) {
    return Math.round(1500 - ((speed - 1) / 19) * 1250);
}

export class IntifaceTransport {
    /**
     * @param {object} opts
     * @param {() => string} opts.getUrl e.g. ws://127.0.0.1:12345
     * @param {typeof WebSocket} [opts.WebSocketImpl]
     */
    constructor({ getUrl, WebSocketImpl = globalThis.WebSocket }) {
        this.getUrl = getUrl;
        this.WebSocketImpl = WebSocketImpl;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.devices = new Map();
        this.listeners = new Set();
        this.pingTimer = null;
        this.strokers = new Map(); // deviceId -> { speed, position, timer }
        this.connected = false;
    }

    get name() {
        return 'Intiface';
    }

    /** @returns {Promise<{ok: boolean, message?: string}>} */
    async connect() {
        if (this.connected && this.ws?.readyState === 1) {
            return this.devices.size ? { ok: true } : { ok: false, message: 'Connected to Intiface, but no toys yet. Turn your toy on; Intiface is scanning.' };
        }
        await this.disconnect();
        const url = this.getUrl() || 'ws://127.0.0.1:12345';
        try {
            await new Promise((resolve, reject) => {
                const ws = new this.WebSocketImpl(url);
                this.ws = ws;
                const timer = setTimeout(() => reject(new Error('Timed out connecting to Intiface')), REQUEST_TIMEOUT_MS);
                ws.onopen = () => { clearTimeout(timer); resolve(); };
                ws.onerror = () => { clearTimeout(timer); reject(new Error(`Could not reach Intiface at ${url}. Is Intiface Central running with its server started?`)); };
                ws.onclose = () => this.handleClose();
                ws.onmessage = (event) => this.handleMessage(event.data);
            });
            const info = await this.request('RequestServerInfo', { ClientName: CLIENT_NAME, MessageVersion: 3 });
            const maxPing = Number(info.MaxPingTime) || 0;
            if (maxPing > 0) {
                this.pingTimer = setInterval(() => this.request('Ping').catch(() => {}), Math.max(500, Math.floor(maxPing / 2)));
            }
            const list = await this.request('RequestDeviceList');
            for (const raw of list.Devices || []) this.addDevice(raw);
            await this.request('StartScanning').catch(() => {});
            this.connected = true;
            return this.devices.size ? { ok: true } : { ok: false, message: 'Connected to Intiface, but no toys yet. Turn your toy on; Intiface is scanning.' };
        } catch (error) {
            await this.disconnect();
            return { ok: false, message: error.message };
        }
    }

    async disconnect() {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        for (const id of [...this.strokers.keys()]) this.stopStroker(id);
        const ws = this.ws;
        this.ws = null;
        this.connected = false;
        if (ws) {
            ws.onclose = null;
            try { ws.close(); } catch { /* already closed */ }
        }
        for (const { reject } of this.pending.values()) reject(new Error('Disconnected'));
        this.pending.clear();
        if (this.devices.size) {
            this.devices.clear();
            this.emitDevices();
        }
    }

    handleClose() {
        this.ws = null;
        this.disconnect();
    }

    request(type, fields = {}) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== 1) {
                reject(new Error('Not connected to Intiface'));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${type} timed out`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (msg) => { clearTimeout(timer); resolve(msg); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            });
            this.ws.send(JSON.stringify([{ [type]: { Id: id, ...fields } }]));
        });
    }

    handleMessage(data) {
        let messages;
        try {
            messages = JSON.parse(data);
        } catch {
            return;
        }
        for (const entry of messages) {
            const [type, msg] = Object.entries(entry)[0] || [];
            if (!type) continue;
            if (msg.Id && this.pending.has(msg.Id)) {
                const { resolve, reject } = this.pending.get(msg.Id);
                this.pending.delete(msg.Id);
                if (type === 'Error') reject(new Error(msg.ErrorMessage || 'Intiface error'));
                else resolve(msg);
                continue;
            }
            if (type === 'DeviceAdded') this.addDevice(msg);
            else if (type === 'DeviceRemoved') this.removeDevice(String(msg.DeviceIndex));
        }
    }

    addDevice(raw) {
        const device = parseDevice(raw);
        if (!device.outputs.length) return;
        this.devices.set(device.id, device);
        this.emitDevices();
        this.readBattery(device);
    }

    removeDevice(id) {
        this.stopStroker(id);
        if (this.devices.delete(id)) this.emitDevices();
    }

    async readBattery(device) {
        try {
            const raw = await this.request('SensorReadCmd', { DeviceIndex: device.index, SensorIndex: 0, SensorType: 'Battery' });
            const level = raw?.Data?.[0];
            if (typeof level === 'number') {
                device.battery = level <= 1 ? Math.round(level * 100) : level;
                this.emitDevices();
            }
        } catch {
            // Device has no battery sensor.
        }
    }

    emitDevices() {
        const list = this.listDevices();
        for (const cb of this.listeners) cb(list);
    }

    onDevicesChanged(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    listDevices() {
        return [...this.devices.values()];
    }

    async send(deviceId, values) {
        const device = this.devices.get(deviceId);
        if (!device) return;
        if ('thrust' in values && device.outputs.some((o) => o.kind === 'linear')) {
            this.setStroker(device, values.thrust);
        }
        await Promise.all(buildCommands(device, values).map(([type, fields]) => this.request(type, fields)));
    }

    /** Linear toys (strokers) need continuous back-and-forth moves; thrust sets the speed. */
    setStroker(device, speed) {
        const current = this.strokers.get(device.id);
        if (speed <= 0) {
            this.stopStroker(device.id);
            return;
        }
        if (current) {
            current.speed = speed;
            return;
        }
        const state = { speed, position: 0, timer: null };
        this.strokers.set(device.id, state);
        const move = () => {
            if (this.strokers.get(device.id) !== state) return;
            const duration = strokeDuration(state.speed);
            state.position = state.position ? 0 : 1;
            const vectors = device.outputs
                .filter((o) => o.kind === 'linear')
                .map((o) => ({ Index: o.index, Duration: duration, Position: state.position }));
            this.request('LinearCmd', { DeviceIndex: device.index, Vectors: vectors }).catch(() => {});
            state.timer = setTimeout(move, duration);
        };
        move();
    }

    stopStroker(id) {
        const state = this.strokers.get(id);
        if (!state) return;
        clearTimeout(state.timer);
        this.strokers.delete(id);
    }

    async stopAll() {
        for (const id of [...this.strokers.keys()]) this.stopStroker(id);
        if (!this.connected) return;
        await this.request('StopAllDevices').catch(() => {});
    }
}
