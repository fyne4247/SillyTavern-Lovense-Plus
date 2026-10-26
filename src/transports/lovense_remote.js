/**
 * Lovense Remote / Lovense Connect transport (Game Mode LAN API), reached
 * through the SillyTavern server plugin in server/lovense.mjs.
 */

// Fallback channel map by toy type when the app doesn't report functions.
const TOY_CHANNELS = {
    nora: ['vibrate', 'rotate'],
    diamo: ['vibrate', 'rotate'],
    ridge: ['vibrate', 'rotate'],
    max: ['vibrate', 'pump'],
    'max 2': ['vibrate', 'pump'],
    edge: ['vibrate', 'vibrate2'],
    'edge 2': ['vibrate', 'vibrate2'],
    gemini: ['vibrate', 'vibrate2'],
    dolce: ['vibrate', 'vibrate2'],
    gravity: ['vibrate', 'thrust'],
    'sex machine': ['vibrate', 'thrust'],
    'mini sex machine': ['vibrate', 'thrust'],
    solace: ['vibrate', 'thrust'],
    'solace pro': ['vibrate', 'thrust'],
    flexer: ['vibrate', 'fingering'],
    tenera: ['vibrate', 'suction'],
    'tenera 2': ['vibrate', 'suction'],
    osci: ['vibrate', 'oscillate'],
    'osci 2': ['vibrate', 'oscillate'],
    'osci 3': ['vibrate', 'oscillate'],
};

// Lovense function names reported by the app -> our channel names.
const FUNCTION_CHANNELS = {
    vibrate: 'vibrate',
    vibrate1: 'vibrate',
    vibrate2: 'vibrate2',
    rotate: 'rotate',
    pump: 'pump',
    thrusting: 'thrust',
    fingering: 'fingering',
    suction: 'suction',
    oscillate: 'oscillate',
};

// Our channel names -> Lovense Function action names.
const ACTIONS = {
    vibrate: 'Vibrate',
    rotate: 'Rotate',
    pump: 'Pump',
    thrust: 'Thrusting',
    fingering: 'Fingering',
    suction: 'Suction',
    oscillate: 'Oscillate',
};

// Each command keeps running this long unless replaced; the player refreshes sooner.
const COMMAND_SECONDS = 30;

export function formatLovenseHost(ip) {
    if (!ip) return '127-0-0-1.lovense.club';
    let host = ip.trim();
    if (host.endsWith('.lovense.club')) return host;
    if (host === 'localhost') host = '127.0.0.1';
    return `${host.replace(/\./g, '-')}.lovense.club`;
}

/** Lovense HTTP API runs on 20xxx ports, HTTPS on 30xxx. */
export function getLovenseProtocol(port) {
    const portNum = parseInt(port);
    return portNum >= 20000 && portNum < 30000 ? 'http' : 'https';
}

/**
 * Work out a toy's channels from a GetToys entry.
 * @param {object} toy
 * @returns {string[]}
 */
export function toyChannels(toy) {
    const reported = Array.isArray(toy.fullFunctionNames) ? toy.fullFunctionNames : null;
    if (reported?.length) {
        const channels = new Set();
        for (const fn of reported) {
            const ch = FUNCTION_CHANNELS[String(fn).toLowerCase()];
            if (ch) channels.add(ch);
        }
        channels.add('vibrate');
        return [...channels];
    }
    const type = String(toy.name || toy.toyType || '').toLowerCase();
    return TOY_CHANNELS[type] || ['vibrate'];
}

/**
 * Build the Function action string for one set of channel values.
 * Dual-motor toys get Vibrate1/Vibrate2 so the motors can differ.
 */
export function buildAction(values) {
    const parts = [];
    if ('vibrate2' in values) {
        parts.push(`Vibrate1:${values.vibrate ?? 0}`, `Vibrate2:${values.vibrate2}`);
    } else if ('vibrate' in values) {
        parts.push(`Vibrate:${values.vibrate}`);
    }
    for (const [ch, action] of Object.entries(ACTIONS)) {
        if (ch === 'vibrate' || !(ch in values)) continue;
        parts.push(`${action}:${values[ch]}`);
    }
    return parts.join(',');
}

export class LovenseRemoteTransport {
    /**
     * @param {object} opts
     * @param {(body: object) => Promise<any>} opts.request Posts a command through the server plugin and returns parsed JSON
     * @param {() => {ip: string, port: string}} opts.getAddress
     */
    constructor({ request, getAddress }) {
        this.request = request;
        this.getAddress = getAddress;
        this.devices = [];
        this.connected = false;
        this.listeners = new Set();
    }

    get name() {
        return 'Lovense Remote';
    }

    url() {
        const { ip, port } = this.getAddress();
        return `${getLovenseProtocol(port)}://${formatLovenseHost(ip)}:${port}/command`;
    }

    async call(command) {
        return this.request({ url: this.url(), ...command });
    }

    /**
     * Ask the app for its toys. Resolves to a status object; never throws.
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    async connect() {
        let status;
        try {
            const data = await this.call({ command: 'GetToys' });
            if (data?.code === 200 && data.data?.toys) {
                const toys = typeof data.data.toys === 'string' ? JSON.parse(data.data.toys) : data.data.toys;
                this.setDevices(Object.entries(toys)
                    .filter(([, toy]) => toy.status === undefined || String(toy.status) === '1')
                    .map(([id, toy]) => ({
                        id,
                        name: toy.nickName ? `${toy.name} (${toy.nickName})` : (toy.name || 'Unknown'),
                        channels: toyChannels(toy),
                        battery: toy.battery ?? null,
                        raw: toy,
                    })));
                status = this.devices.length ? { ok: true } : { ok: false, message: 'The app is reachable, but no toy is connected.' };
            } else if (data?.code === 401) {
                status = { ok: false, message: 'Lovense app connected, but no toy found. Pair your toy in Lovense Remote.' };
            } else if (data?.code === 402) {
                status = { ok: false, message: 'Toy found but not connected. Check Bluetooth in Lovense Remote.' };
            } else {
                status = { ok: false, message: data?.error || `Unexpected response (code ${data?.code})` };
            }
        } catch (error) {
            status = { ok: false, message: error.message };
        }
        if (!status.ok && status.message) this.setDevices([]);
        this.connected = status.ok;
        return status;
    }

    async disconnect() {
        this.connected = false;
        this.setDevices([]);
    }

    setDevices(devices) {
        this.devices = devices;
        for (const cb of this.listeners) cb(devices);
    }

    onDevicesChanged(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    listDevices() {
        return this.devices;
    }

    async send(deviceId, values) {
        const action = buildAction(values);
        if (!action) return;
        return this.call({ command: 'Function', action, timeSec: COMMAND_SECONDS, toy: deviceId, apiVer: 1 });
    }

    /** Send a raw Lovense API command (Legacy Mode presets and patterns). */
    async sendRaw(command) {
        return this.call(command);
    }

    async stopAll() {
        if (!this.connected) return;
        return this.call({ command: 'Function', action: 'Stop', timeSec: 0, apiVer: 1 }).catch(() => {});
    }
}
