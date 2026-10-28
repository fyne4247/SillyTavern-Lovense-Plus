import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    setExtensionPrompt,
    getRequestHeaders,
} from '../../../../script.js';
import {
    extension_settings,
} from '../../../extensions.js';
import { LovenseRemoteTransport } from './src/transports/lovense_remote.js';
import { IntifaceTransport } from './src/transports/intiface.js';
import { PatternLibrary, pickFromMood, patternLength, patternFitsChannels, reconcileLengthSecs } from './src/patterns.js';
import { Player } from './src/player.js';
import { Scheduler } from './src/scheduler.js';
import { pickPattern } from './src/picker/script.js';
import { ApiPicker, DEFAULT_PICKER_PROMPT } from './src/picker/api.js';
import { LegacyController, buildLegacyPrompt, DEFAULT_GUIDELINES } from './src/legacy.js';

const MODULE_NAME = 'lovense';
const EXTENSION_PROMPT_TAG = 'lovense_control';
const BASE_URL = new URL('.', import.meta.url);
const CONNECTION_CHECK_MS = 10000;
// Messages rendered right after a chat loads aren't new; don't react to them.
const CHAT_LOAD_GRACE_MS = 1500;
const RECENT_LIMIT = 5;

const defaultSettings = {
    enabled: false,
    transport: 'lovense',
    local_ip: '127.0.0.1',
    local_port: '30010',
    intiface_url: 'ws://127.0.0.1:12345',
    mode: 'script',
    delay_sec: 4,
    trigger_char: true,
    trigger_user: false,
    loop: true,
    min_length_sec: 0,
    max_length_sec: 0,
    filter_specialized: true,
    pump_slowdown: 4,
    idle_enabled: false,
    idle_minutes: 5,
    idle_mood: 'ambient',
    fallback_mood: '',
    moods: {},
    api_profile: '',
    api_max_tokens: 300,
    api_pick_pattern: false,
    api_prompt: DEFAULT_PICKER_PROMPT,
    guidelines: DEFAULT_GUIDELINES,
};

const library = new PatternLibrary();
const transports = {
    lovense: new LovenseRemoteTransport({
        request: lovensePluginRequest,
        getAddress: () => ({ ip: settings().local_ip, port: settings().local_port }),
    }),
    intiface: new IntifaceTransport({
        getUrl: () => settings().intiface_url,
    }),
};
const player = new Player({
    transport: {
        listDevices: () => transport().listDevices(),
        send: (id, values) => transport().send(id, values),
        stopAll: () => transport().stopAll(),
    },
    onChange: renderNowPlaying,
    getPumpSlowdown: () => Number(settings().pump_slowdown) || 1,
});
const scheduler = new Scheduler({
    getDelayMs: () => Math.max(0, Number(settings().delay_sec) || 0) * 1000,
    onFire: onSchedulerFire,
});
const apiPicker = new ApiPicker({ complete: completeWithProfile });
const legacy = new LegacyController({
    getTransport: () => transport(),
    player,
    presetLookup: (mood) => {
        const file = library.moods.get(mood);
        if (!file) return null;
        const patterns = file.patterns.filter((pattern) => patternFitsChannels(pattern, featureChannels()));
        return patterns.length ? pickFromMood({ patterns }, 3) : null;
    },
});

let connectionCheckInterval = null;
// Last toy-feature set the pattern lists were drawn for, so a status poll
// doesn't rebuild the dropdowns unless a toy gained or lost a feature.
let listedChannelKey = '';
let idleTimer = null;
let chatLoadedAt = 0;
let pickToken = 0;
let lastPickReason = '';
const recent = [];

function settings() {
    return extension_settings[MODULE_NAME];
}

function transport() {
    return transports[settings().transport] || transports.lovense;
}

function isLegacy() {
    return settings().mode === 'legacy';
}

/** A length dropdown in ms, or 0 when that side is open. */
function lengthSecToMs(sec) {
    return Math.max(0, Number(sec) || 0) * 1000;
}

function minLengthMs() {
    return lengthSecToMs(settings().min_length_sec);
}

function maxLengthMs() {
    return lengthSecToMs(settings().max_length_sec);
}

/** Keep the minimum from sitting above a real maximum. */
function reconcileLengthRange(changed) {
    const next = reconcileLengthSecs(settings().min_length_sec, settings().max_length_sec, changed);
    const minChanged = String(next.min) !== String(Number(settings().min_length_sec) || 0);
    const maxChanged = String(next.max) !== String(Number(settings().max_length_sec) || 0);
    if (!minChanged && !maxChanged) return;
    settings().min_length_sec = String(next.min);
    settings().max_length_sec = String(next.max);
    $('#lovense_min_length').val(String(next.min));
    $('#lovense_max_length').val(String(next.max));
    saveSettingsDebounced();
}

/** Milliseconds as m:ss. */
function formatLength(ms) {
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Features the connected toys actually have, or null when the filter is off
 * or no toy has reported in yet. Null means "don't hide anything".
 * @returns {Set<string>|null}
 */
function featureChannels() {
    if (!settings().filter_specialized) return null;
    const devices = transport().listDevices();
    if (!devices.length) return null;
    const channels = new Set();
    for (const device of devices) {
        for (const channel of device.channels || []) channels.add(channel);
    }
    return channels;
}

/** Enabled moods, trimmed by the length limit and by what the toys can do. */
function pickableMoods() {
    return library.enabledMoods(settings().moods, maxLengthMs(), featureChannels(), minLengthMs());
}

/** Stable label for a feature set, so the UI can tell when it changed. */
function channelKey(channels) {
    return channels ? [...channels].sort().join(',') : '*';
}

/**
 * Post a command through the server plugin (server/lovense.mjs).
 */
async function lovensePluginRequest(body) {
    const response = await fetch('/api/plugins/lovense/command', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (response.status === 404) {
        throw new Error('Server plugin not found. Copy server/lovense.mjs into SillyTavern/plugins and enable server plugins.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(data?.details || data?.error || `HTTP ${response.status}`);
    }
    return data;
}

/**
 * Send a chat request through the chosen connection profile and return the reply text.
 */
async function completeWithProfile(messages, maxTokens) {
    const context = SillyTavern.getContext();
    const profileId = settings().api_profile;
    if (!profileId) throw new Error('No connection profile selected for the picker');
    const result = await context.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {
        includePreset: true,
        includeInstruct: true,
    });
    return typeof result === 'string' ? result : (result?.content ?? '');
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function checkConnection() {
    const status = await transport().connect();
    updateConnectionStatus();
    updatePrompt();
    return status;
}

function updateConnectionStatus() {
    const devices = transport().listDevices();
    const statusDiv = $('#lovense_status');
    const toysList = $('#lovense_toy_list');
    const buttons = $('#lovense_test_controls button, #lovense_try_play');

    if (devices.length > 0) {
        statusDiv.removeClass('disconnected').addClass('connected');
        $('#lovense_status_text').text(`Connected via ${transport().name}`);
        toysList.empty();
        for (const device of devices) {
            const item = $('<li class="lovense_toy_item"></li>');
            const left = $('<div></div>');
            left.append($('<div class="lovense_toy_name"></div>').text(device.name));
            left.append($('<div class="lovense_toy_channels"></div>').text(device.channels.join(', ')));
            item.append(left);
            if (device.battery !== null && device.battery !== undefined) {
                item.append($('<span class="lovense_toy_battery"></span>').text(`Battery: ${device.battery}%`));
            }
            toysList.append(item);
        }
        $('#lovense_toys_section').show();
        buttons.prop('disabled', false);
    } else {
        statusDiv.removeClass('connected').addClass('disconnected');
        $('#lovense_status_text').text(transport().connected ? `Connected to ${transport().name}, no toys` : 'Not Connected');
        $('#lovense_toys_section').hide();
        buttons.prop('disabled', true);
        $('#lovense_stop_all').prop('disabled', false);
    }
    const key = channelKey(featureChannels());
    if (library.size && key !== listedChannelKey) renderMoods();
}

function startConnectionChecking() {
    if (connectionCheckInterval) return;
    checkConnection();
    connectionCheckInterval = setInterval(checkConnection, CONNECTION_CHECK_MS);
}

function stopConnectionChecking() {
    clearInterval(connectionCheckInterval);
    connectionCheckInterval = null;
}

async function switchTransport(name) {
    await player.stop();
    legacy.stopLoop();
    await transport().disconnect();
    settings().transport = name;
    saveSettingsDebounced();
    renderTransportFields();
    updateConnectionStatus();
    if (settings().enabled) checkConnection();
}

// ---------------------------------------------------------------------------
// Picking and playing
// ---------------------------------------------------------------------------

function messageMatchesTriggers(message) {
    if (!message || message.is_system) return false;
    return message.is_user ? settings().trigger_user : settings().trigger_char;
}

/** A message settled (rendered, swiped to, edited): start the countdown. */
function scheduleFor(messageId) {
    if (!settings().enabled || isLegacy()) return;
    if (Date.now() - chatLoadedAt < CHAT_LOAD_GRACE_MS) return;
    const chat = SillyTavern.getContext().chat;
    const id = Number(messageId);
    if (id !== chat.length - 1) return;
    if (!messageMatchesTriggers(chat[id])) return;
    scheduler.schedule(id);
}

async function onSchedulerFire(messageId) {
    const chat = SillyTavern.getContext().chat;
    // The chat moved on (deleted, new message) while we were waiting.
    if (messageId !== chat.length - 1) return;
    const message = chat[messageId];
    if (!messageMatchesTriggers(message)) return;
    if (!transport().listDevices().length) return;
    await pickAndPlay(message.mes || '');
}

async function pickAndPlay(text) {
    const token = ++pickToken;
    const moods = pickableMoods();
    if (!moods.length) return;

    let choice = null;
    let reason = 'script';
    if (settings().mode === 'api') {
        try {
            choice = await apiPicker.pick(text, moods, {
                prompt: settings().api_prompt,
                maxTokens: Number(settings().api_max_tokens) || defaultSettings.api_max_tokens,
                pickPattern: settings().api_pick_pattern,
                recent,
            });
            reason = 'API';
            if (!choice) console.warn('[Lovense] Picker model gave an unusable reply; using the script picker');
        } catch (error) {
            console.warn('[Lovense] Picker model call failed; using the script picker', error);
            toastr.warning(`Lovense picker: ${error.cause?.message || error.message}. Using keyword matching instead.`, '', { preventDuplicates: true });
        }
    }
    if (!choice) {
        choice = pickPattern(text, moods, {
            recent,
            fallbackMood: settings().fallback_mood || null,
            playing: player.playing,
        });
        reason = 'script';
    }

    // A newer message arrived while the picker was thinking.
    if (token !== pickToken || !choice) return;
    lastPickReason = `${reason}: ${choice.mood}, energy ${choice.energy}`;
    playPattern(choice.pattern);
}

function playPattern(pattern) {
    recent.unshift(pattern.id);
    recent.length = Math.min(recent.length, RECENT_LIMIT);
    player.play(pattern, { loop: settings().loop });
    resetIdleTimer();
}

function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!settings().enabled || !settings().idle_enabled || isLegacy()) return;
    const minutes = Math.max(1, Number(settings().idle_minutes) || defaultSettings.idle_minutes);
    idleTimer = setTimeout(() => {
        const mood = library.enabledMoods({}, maxLengthMs(), featureChannels(), minLengthMs()).find((m) => m.mood === settings().idle_mood);
        if (!mood || !transport().listDevices().length) return;
        lastPickReason = `idle: ${mood.mood}`;
        const pattern = pickFromMood(mood, 1, recent);
        recent.unshift(pattern.id);
        recent.length = Math.min(recent.length, RECENT_LIMIT);
        player.play(pattern, { loop: true });
    }, minutes * 60000);
}

async function stopEverything() {
    pickToken++;
    scheduler.cancel();
    clearTimeout(idleTimer);
    await legacy.stop();
}

function renderNowPlaying({ pattern }) {
    const box = $('#lovense_now_playing');
    if (!pattern) {
        box.text('Nothing');
        return;
    }
    const mood = library.moods.get(pattern.mood);
    box.empty();
    box.append($('<b></b>').text(pattern.name || pattern.id));
    if (mood) box.append(document.createTextNode(` · ${mood.label}`));
    if (pattern.description) box.append($('<small></small>').text(pattern.description));
    if (lastPickReason) box.append($('<small></small>').text(`Picked by ${lastPickReason}`));
}

// ---------------------------------------------------------------------------
// Legacy Mode prompt
// ---------------------------------------------------------------------------

function updatePrompt() {
    const devices = transport().listDevices();
    const active = settings().enabled && isLegacy() && devices.length > 0;
    const prompt = active ? buildLegacyPrompt(devices, settings().guidelines) : '';
    setExtensionPrompt(EXTENSION_PROMPT_TAG, prompt, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun || type === 'quiet') return;
    scheduler.cancel();
    if (isLegacy()) legacy.reset();
}

async function onStreamTokenReceived(data) {
    if (!settings().enabled || !isLegacy()) return;
    const token = typeof data === 'string' ? data : (data?.text || data?.message || '');
    if (token) await legacy.onStreamToken(token);
}

function onGenerationEnded() {
    if (!settings().enabled || !isLegacy()) return;
    legacy.onGenerationEnded();
}

function onMessageReceived(data) {
    if (!settings().enabled || !isLegacy()) return;
    // Streaming already collected the commands; this is the non-streaming fallback.
    if (legacy.commands.length) return;
    const messageId = typeof data === 'number' ? data : data?.index;
    const message = SillyTavern.getContext().chat[messageId];
    if (!message || message.is_user) return;
    legacy.onMessage(message.mes || '');
}

function onMessageSwiped(messageId) {
    // Swiping to an existing swipe doesn't generate, so schedule now; if it
    // does generate, GENERATION_STARTED cancels this and the render reschedules.
    scheduleFor(messageId);
}

function onMessageDeleted() {
    scheduler.cancel();
}

function onChatChanged() {
    chatLoadedAt = Date.now();
    scheduler.cancel();
    pickToken++;
    if (player.playing) player.stop();
    legacy.stopLoop();
    updatePrompt();
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function loadSettings() {
    extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME] || {});
    const s = settings();
    // v1 stored connection state in settings; it's live state now.
    delete s.connected;
    delete s.toys;

    $('#lovense_enabled').prop('checked', s.enabled);
    $('#lovense_transport').val(s.transport);
    $('#lovense_local_ip').val(s.local_ip);
    $('#lovense_local_port').val(s.local_port);
    $('#lovense_intiface_url').val(s.intiface_url);
    $('#lovense_mode').val(s.mode);
    $('#lovense_delay').val(s.delay_sec);
    $('#lovense_trigger_char').prop('checked', s.trigger_char);
    $('#lovense_trigger_user').prop('checked', s.trigger_user);
    $('#lovense_loop').prop('checked', s.loop);
    $('#lovense_min_length').val(String(s.min_length_sec ?? 0));
    $('#lovense_max_length').val(String(s.max_length_sec));
    $('#lovense_filter_specialized').prop('checked', s.filter_specialized !== false);
    $('#lovense_pump_slowdown').val(String(s.pump_slowdown ?? 4));
    $('#lovense_idle_enabled').prop('checked', s.idle_enabled);
    $('#lovense_idle_minutes').val(s.idle_minutes);
    $('#lovense_api_max_tokens').val(s.api_max_tokens);
    $('#lovense_api_pick_pattern').prop('checked', s.api_pick_pattern);
    $('#lovense_api_prompt').val(s.api_prompt);
    $('#lovense_guidelines').val(s.guidelines);

    renderTransportFields();
    renderModeFields();
    $('#lovense_idle_options').toggle(!!s.idle_enabled);
}

function renderTransportFields() {
    $('#lovense_transport_lovense').toggle(settings().transport === 'lovense');
    $('#lovense_transport_intiface').toggle(settings().transport === 'intiface');
}

function renderModeFields() {
    const mode = settings().mode;
    $('#lovense_api_section').toggle(mode === 'api');
    $('#lovense_legacy_section').toggle(mode === 'legacy');
    $('#lovense_timing_section').toggle(mode !== 'legacy');
    $('#lovense_moods_section').toggle(mode !== 'legacy');
    $('#lovense_fallback_row').toggle(mode === 'script');
    const notes = {
        script: 'Matches words in each message against every mood\'s keywords. Free and instant.',
        api: 'A separate model reads each finished message and picks the mood. Your chat model never has to think about toys.',
        legacy: 'The chat model writes <lovense:.../> commands into its replies, like v1. This uses the chat model\'s tokens.',
    };
    $('#lovense_mode_note').text(notes[mode] || '');
}

function renderMoods() {
    const s = settings();
    const channels = featureChannels();
    listedChannelKey = channelKey(channels);
    const list = $('#lovense_mood_list').empty();
    const fitting = new Map(library.enabledMoods({}, maxLengthMs(), channels, minLengthMs()).map((m) => [m.mood, m.patterns.length]));
    for (const mood of library.moods.values()) {
        const id = `lovense_mood_${mood.mood}`;
        const label = $('<label class="checkbox_label"></label>').attr('for', id).attr('title', mood.description);
        const box = $('<input type="checkbox" />').attr('id', id).prop('checked', s.moods[mood.mood] !== false);
        box.on('change', function () {
            s.moods[mood.mood] = $(this).prop('checked');
            saveSettingsDebounced();
        });
        const total = mood.patterns.length;
        const fits = fitting.get(mood.mood) ?? 0;
        label.append(box, $('<span></span>').text(mood.label), $('<small></small>').text(fits === total ? total : `${fits}/${total}`));
        list.append(label);
    }
    const fitTotal = [...fitting.values()].reduce((a, n) => a + n, 0);
    $('#lovense_pattern_count').text(patternCountLabel(fitTotal, channels));

    $('.lovense_mood_select').each(function () {
        const select = $(this).empty();
        if (select.data('allow-none')) select.append($('<option value=""></option>').text('Keep quiet'));
        for (const mood of library.moods.values()) {
            select.append($('<option></option>').val(mood.mood).text(mood.label));
        }
    });
    $('#lovense_idle_mood').val(s.idle_mood);
    $('#lovense_fallback_mood').val(s.fallback_mood);
    renderTryPatterns();
}

/** "431 patterns", or how many survive the length limit and the toy filter. */
function patternCountLabel(shown, channels) {
    if (shown === library.size) return `${library.size} patterns`;
    const reasons = [];
    if (minLengthMs() || maxLengthMs()) reasons.push('the length range');
    if (channels) reasons.push('your toys');
    const why = reasons.length ? ` fit ${reasons.join(' and ')}` : '';
    return `${shown} of ${library.size} patterns${why}`;
}

function renderTryPatterns() {
    const mood = library.moods.get($('#lovense_try_mood').val());
    const channels = featureChannels();
    const select = $('#lovense_try_pattern').empty();
    const patterns = (mood?.patterns || []).filter((pattern) => patternFitsChannels(pattern, channels));
    if (!patterns.length) {
        select.append($('<option value=""></option>').text(channels ? 'None match your toys' : 'No patterns'));
    }
    for (const p of patterns) {
        select.append($('<option></option>').val(p.id).text(`${p.name} · ${formatLength(patternLength(p))} · energy ${p.energy}`));
    }
    renderTryDescription();
}

function renderTryDescription() {
    const pattern = library.get($('#lovense_try_pattern').val());
    $('#lovense_try_description').text(pattern?.description || '');
}

function setupApiProfileDropdown() {
    try {
        SillyTavern.getContext().ConnectionManagerRequestService.handleDropdown('#lovense_api_profile', settings().api_profile);
    } catch (error) {
        console.warn('[Lovense] Connection profiles unavailable', error);
        $('#lovense_api_profile').empty().append($('<option value=""></option>').text('Connection Manager is disabled'));
    }
}

function bindSetting(selector, key, { type = 'text', after } = {}) {
    const event = type === 'checkbox' || type === 'select' ? 'change' : 'input';
    $(selector).on(event, function () {
        let value = type === 'checkbox' ? $(this).prop('checked') : $(this).val();
        if (type === 'number') value = Number(value);
        settings()[key] = value;
        saveSettingsDebounced();
        after?.(value);
    });
}

function setupUI() {
    $('#lovense_enabled').on('change', async function () {
        settings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        if (settings().enabled) {
            startConnectionChecking();
        } else {
            stopConnectionChecking();
            await stopEverything();
        }
        updatePrompt();
    });

    $('#lovense_transport').on('change', function () {
        switchTransport($(this).val());
    });
    bindSetting('#lovense_local_ip', 'local_ip');
    bindSetting('#lovense_local_port', 'local_port');
    bindSetting('#lovense_intiface_url', 'intiface_url');

    bindSetting('#lovense_mode', 'mode', {
        type: 'select',
        after: async () => {
            renderModeFields();
            await stopEverything();
            updatePrompt();
        },
    });
    bindSetting('#lovense_delay', 'delay_sec', { type: 'number' });
    bindSetting('#lovense_trigger_char', 'trigger_char', { type: 'checkbox' });
    bindSetting('#lovense_trigger_user', 'trigger_user', { type: 'checkbox' });
    bindSetting('#lovense_loop', 'loop', { type: 'checkbox', after: (loop) => player.setLoop(loop) });
    bindSetting('#lovense_min_length', 'min_length_sec', {
        type: 'select',
        after: () => { reconcileLengthRange('min'); renderMoods(); },
    });
    bindSetting('#lovense_max_length', 'max_length_sec', {
        type: 'select',
        after: () => { reconcileLengthRange('max'); renderMoods(); },
    });
    bindSetting('#lovense_filter_specialized', 'filter_specialized', { type: 'checkbox', after: renderMoods });
    bindSetting('#lovense_pump_slowdown', 'pump_slowdown', { type: 'select' });
    bindSetting('#lovense_idle_enabled', 'idle_enabled', {
        type: 'checkbox',
        after: (on) => {
            $('#lovense_idle_options').toggle(on);
            resetIdleTimer();
        },
    });
    bindSetting('#lovense_idle_minutes', 'idle_minutes', { type: 'number', after: resetIdleTimer });
    bindSetting('#lovense_idle_mood', 'idle_mood', { type: 'select' });
    bindSetting('#lovense_fallback_mood', 'fallback_mood', { type: 'select' });

    bindSetting('#lovense_api_profile', 'api_profile', { type: 'select' });
    bindSetting('#lovense_api_max_tokens', 'api_max_tokens', { type: 'number' });
    bindSetting('#lovense_api_pick_pattern', 'api_pick_pattern', { type: 'checkbox' });
    bindSetting('#lovense_api_prompt', 'api_prompt');
    $('#lovense_api_prompt_reset').on('click', () => {
        settings().api_prompt = DEFAULT_PICKER_PROMPT;
        $('#lovense_api_prompt').val(DEFAULT_PICKER_PROMPT);
        saveSettingsDebounced();
    });

    bindSetting('#lovense_guidelines', 'guidelines', { after: updatePrompt });
    $('#lovense_reset_guidelines').on('click', () => {
        settings().guidelines = DEFAULT_GUIDELINES;
        $('#lovense_guidelines').val(DEFAULT_GUIDELINES);
        saveSettingsDebounced();
        updatePrompt();
        toastr.success('Guidelines reset to default');
    });

    $('#lovense_moods_all, #lovense_moods_none').on('click', function () {
        const on = this.id === 'lovense_moods_all';
        for (const mood of library.moods.keys()) settings().moods[mood] = on;
        saveSettingsDebounced();
        renderMoods();
    });

    $('#lovense_connect_button').on('click', async () => {
        toastr.info(`Connecting to ${transport().name}...`);
        const status = await checkConnection();
        if (status.ok) {
            toastr.success(`Connected: ${transport().listDevices().map((d) => d.name).join(', ')}`);
        } else {
            toastr.error(status.message || 'Could not connect.');
        }
    });

    $('#lovense_try_mood').on('change', renderTryPatterns);
    $('#lovense_try_pattern').on('change', renderTryDescription);
    $('#lovense_try_play').on('click', () => {
        const pattern = library.get($('#lovense_try_pattern').val());
        if (!pattern) return;
        lastPickReason = 'hand';
        playPattern(pattern);
    });

    $('#lovense_test_vibrate').on('click', () => {
        lastPickReason = 'test button';
        player.play({ id: 'test', name: 'Test vibrate', steps: [{ ms: 3000, vibrate: 10 }] }, { loop: false });
        toastr.info('Vibrating at 10/20 for 3 seconds');
    });

    $('#lovense_stop_all').on('click', async () => {
        await stopEverything();
        toastr.success('All devices stopped');
    });
}

jQuery(async () => {
    const settingsHtml = await (await fetch(new URL('settings.html', BASE_URL))).text();
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    setupUI();
    setupApiProfileDropdown();

    for (const t of Object.values(transports)) {
        t.onDevicesChanged(() => {
            if (t !== transport()) return;
            updateConnectionStatus();
            updatePrompt();
        });
    }
    updateConnectionStatus();

    try {
        await library.load(new URL('patterns/', BASE_URL));
        console.log(`[Lovense] Loaded ${library.size} patterns in ${library.moods.size} moods`);
    } catch (error) {
        console.error('[Lovense] Could not load the pattern library', error);
        toastr.error('Lovense: could not load patterns. Script and API modes need them.');
    }
    renderMoods();

    if (settings().enabled) startConnectionChecking();

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleFor);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, scheduleFor);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_EDITED, scheduleFor);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Don't leave toys running when the tab closes.
    window.addEventListener('pagehide', () => {
        transport().stopAll();
    });

    console.log('[Lovense] Extension initialized');
});
