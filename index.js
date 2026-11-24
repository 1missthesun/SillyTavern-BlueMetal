/*
 * BlueMetal Music for SillyTavern
 * https://github.com/1missthesun/SillyTavern-BlueMetal
 *
 * Scores the current scene with an original instrumental track from BlueMetal
 * (https://bluemetal.ai). The chat model describes the scene in a short music
 * prompt, BlueMetal makes the track, and it loops with a crossfade. Auto mode
 * follows the scene and swaps tracks when the place or mood changes.
 *
 * Uses only SillyTavern.getContext(), so nothing is imported from SillyTavern
 * and the extension works from any install folder.
 */

const MODULE = 'bluemetal';
const API_URL = 'https://api.bluemetal.ai';
const UTM = 'utm_source=sillytavern&utm_medium=extension';
const SITE_URL = `https://bluemetal.ai/?${UTM}`;
const DASHBOARD_URL = `https://bluemetal.ai/dashboard?${UTM}`;
const PRICE_USD = 0.0095;
const SUFFIX = 'instrumental, no vocals';

const LOOP_FADE_S = 6;          // overlap where a track loops back to its start
const SWITCH_FADE_S = 4;        // overlap when one track replaces another
const POLL_FIRST_MS = 3000;
const POLL_MAX_MS = 10000;
const MAX_WAIT_MS = 15 * 60 * 1000; // cold starts can take a few minutes
const URL_TTL_MS = 20 * 60 * 60 * 1000; // audio links last 24 h
const LIBRARY_MAX = 12;

const defaultSettings = Object.freeze({
    apiKey: '',
    enabled: true,
    volume: 40,
    confirmPrompt: true,
    auto: false,
    autoEvery: 4,
    balance: null,
    pending: {},
});

const ctx = () => SillyTavern.getContext();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function uuid() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function money(value) {
    let text = Number(value).toFixed(4).replace(/0+$/, '');
    const decimals = text.split('.')[1]?.length ?? 0;
    if (decimals < 2) text = Number(value).toFixed(2);
    return `$${text}`;
}

// ------------------------------------------------------------------ settings

function settings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE] || typeof extensionSettings[MODULE] !== 'object') {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    s.volume = Math.min(100, Math.max(0, Number(s.volume) || 0));
    s.autoEvery = Math.min(50, Math.max(1, Math.round(Number(s.autoEvery) || defaultSettings.autoEvery)));
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

// ------------------------------------------------------------- chat library
// Each chat keeps its own small list of tracks in its metadata, so a scene
// that comes back reuses its track instead of paying for a new one.

function chatId() {
    try {
        return ctx().getCurrentChatId?.() || null;
    } catch {
        return null;
    }
}

function chatLibrary() {
    const metadata = ctx().chatMetadata;
    if (!metadata) return { tracks: [], current: null };
    if (!metadata[MODULE] || !Array.isArray(metadata[MODULE].tracks)) {
        metadata[MODULE] = { tracks: [], current: null };
    }
    return metadata[MODULE];
}

function saveChatLibrary() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else c.saveMetadata?.();
}

function currentTrack() {
    const lib = chatLibrary();
    return lib.tracks.find(t => t.id === lib.current) ?? null;
}

function addToLibrary(track) {
    const lib = chatLibrary();
    lib.tracks = lib.tracks.filter(t => t.id !== track.id);
    lib.tracks.push(track);
    while (lib.tracks.length > LIBRARY_MAX) {
        const oldest = lib.tracks.findIndex(t => t.id !== lib.current && t.id !== track.id);
        lib.tracks.splice(oldest === -1 ? 0 : oldest, 1);
    }
    saveChatLibrary();
}

function removeFromLibrary(id) {
    const lib = chatLibrary();
    lib.tracks = lib.tracks.filter(t => t.id !== id);
    if (lib.current === id) lib.current = null;
    saveChatLibrary();
}

// A track that finished after its chat was closed waits here until the chat
// is opened again.
function mergePending() {
    const s = settings();
    const id = chatId();
    const waiting = id && s.pending[id];
    if (!waiting?.length) return;
    for (const track of waiting) addToLibrary(track);
    delete s.pending[id];
    saveSettings();
}

// ----------------------------------------------------------------- the API

class BlueMetalError extends Error {
    constructor(code, message, retryAfter = 0) {
        super(message);
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

async function api(path, { method = 'GET', body = undefined, idempotencyKey = undefined } = {}) {
    const key = settings().apiKey.trim();
    if (!key) throw new BlueMetalError('no_key', 'Add your BlueMetal API key in Extensions → BlueMetal Music.');

    const headers = { 'Authorization': `Bearer ${key}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let response;
    try {
        response = await fetch(API_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
        throw new BlueMetalError('network', 'Could not reach BlueMetal. Check your connection.');
    }
    const data = await response.json().catch(() => null);
    if (response.ok) return data;

    const message = data?.error?.message || `BlueMetal answered ${response.status}.`;
    const retryAfter = Number(response.headers.get('retry-after')) || 0;
    if (response.status === 401) throw new BlueMetalError('bad_key', 'BlueMetal did not accept this API key.');
    if (response.status === 402) throw new BlueMetalError('no_credit', 'Your BlueMetal credit has run out. Add credit on the BlueMetal dashboard.');
    if (response.status === 404) throw new BlueMetalError('not_found', message);
    if (response.status === 429 || response.status >= 500) throw new BlueMetalError('busy', message, retryAfter);
    throw new BlueMetalError('api', message);
}

const transient = error => error instanceof BlueMetalError && (error.code === 'network' || error.code === 'busy');

async function refreshBalance() {
    try {
        const account = await api('/v1/account');
        settings().balance = Number(account.credits_usd);
        saveSettings();
    } catch (error) {
        if (error.code === 'bad_key' || error.code === 'no_key') settings().balance = null;
        throw error;
    } finally {
        renderStatus();
    }
}

/** Creates a track and waits for it. Returns the finished generation. */
async function generate(prompt, onProgress) {
    const idempotencyKey = uuid();
    let generation;
    for (let attempt = 0; ; attempt++) {
        try {
            generation = await api('/v1/music/generations', { method: 'POST', body: { prompt, format: 'mp3' }, idempotencyKey });
            break;
        } catch (error) {
            if (!transient(error) || attempt >= 3) throw error;
            await sleep(Math.max(error.retryAfter * 1000, 5000));
        }
    }

    const started = Date.now();
    let delay = POLL_FIRST_MS;
    onProgress?.(generation);
    while (generation.status === 'queued' || generation.status === 'running') {
        if (Date.now() - started > MAX_WAIT_MS) {
            throw new BlueMetalError('timeout', 'BlueMetal is taking unusually long. The track will still appear on your BlueMetal dashboard when it finishes.');
        }
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
        try {
            generation = await api(`/v1/music/generations/${encodeURIComponent(generation.id)}`);
        } catch (error) {
            if (!transient(error)) throw error;
        }
        onProgress?.(generation);
    }
    if (generation.status !== 'succeeded' || !generation.audio?.url) {
        throw new BlueMetalError('failed', generation.error?.message || 'BlueMetal could not make this track. You were not charged.');
    }
    return generation;
}

// Audio links are signed and last 24 hours; reading the generation again
// mints a fresh one.
const urlCache = new Map();

async function audioUrl(id, { fresh = false } = {}) {
    const cached = urlCache.get(id);
    if (!fresh && cached && Date.now() - cached.at < URL_TTL_MS) return cached.url;
    let generation;
    try {
        generation = await api(`/v1/music/generations/${encodeURIComponent(id)}`);
    } catch (error) {
        if (error.code === 'not_found') {
            removeFromLibrary(id);
            renderLibrary();
            throw new BlueMetalError('gone', 'That track is no longer stored on BlueMetal (tracks are kept for 30 days).');
        }
        throw error;
    }
    if (!generation.audio?.url) throw new BlueMetalError('gone', 'That track has no audio.');
    urlCache.set(id, { url: generation.audio.url, at: Date.now() });
    return generation.audio.url;
}

// -------------------------------------------------------------- the player
// Two audio elements take turns. Near the end of a track the idle one starts
// the same track from the top while the playing one fades out, so the loop
// has no gap; a new track crossfades in the same way.

class LoopPlayer {
    constructor() {
        this.decks = [new Audio(), new Audio()];
        this.active = 0;
        this.trackId = null;
        this.url = null;
        this.paused = true;
        this.blocked = false;
        this.looping = false;
        this.fades = new Map();
        this.onChange = () => {};
        this.decks.forEach((deck, index) => {
            deck.preload = 'auto';
            deck.addEventListener('timeupdate', () => this.#onTime(index));
            deck.addEventListener('ended', () => this.#onEnded(index));
            deck.addEventListener('error', () => this.#onError(index));
        });
    }

    get volume() {
        return settings().volume / 100;
    }

    get playing() {
        return Boolean(this.trackId) && !this.paused;
    }

    async play(trackId, url, fadeSeconds = SWITCH_FADE_S) {
        const outgoing = this.decks[this.active];
        const incomingIndex = 1 - this.active;
        const incoming = this.decks[incomingIndex];
        this.#cancelFade(incoming);
        if (incoming.src !== url) incoming.src = url;
        incoming.currentTime = 0;
        incoming.volume = 0;
        this.active = incomingIndex;
        this.trackId = trackId;
        this.url = url;
        this.looping = false;
        this.paused = false;
        try {
            await incoming.play();
            this.blocked = false;
        } catch (error) {
            // Browsers refuse sound until the page has been clicked once.
            if (error?.name === 'NotAllowedError') {
                this.blocked = true;
                this.paused = true;
                this.#resumeOnFirstClick();
                this.onChange();
                return;
            }
            throw error;
        }
        const fade = outgoing.paused ? Math.min(fadeSeconds, 2) : fadeSeconds;
        this.#fade(incoming, this.volume, fade);
        this.#fadeOut(outgoing, fadeSeconds);
        this.onChange();
    }

    pause() {
        if (!this.trackId) return;
        this.paused = true;
        this.decks.forEach(deck => this.#fadeOut(deck, 0.6));
        this.onChange();
    }

    async resume() {
        if (!this.trackId || !this.paused) return;
        const deck = this.decks[this.active];
        this.paused = false;
        try {
            await deck.play();
            this.blocked = false;
        } catch (error) {
            this.paused = true;
            if (error?.name === 'NotAllowedError') {
                this.blocked = true;
                this.#resumeOnFirstClick();
            }
            this.onChange();
            return;
        }
        this.#fade(deck, this.volume, 1.2);
        this.onChange();
    }

    stop(fadeSeconds = 1.5) {
        this.trackId = null;
        this.url = null;
        this.paused = true;
        this.blocked = false;
        this.decks.forEach(deck => this.#fadeOut(deck, fadeSeconds, true));
        this.onChange();
    }

    setVolume() {
        const deck = this.decks[this.active];
        if (!this.paused && !this.fades.has(deck)) deck.volume = this.volume;
    }

    #resumeOnFirstClick() {
        if (this.waitingForClick) return;
        this.waitingForClick = true;
        const resume = () => {
            this.waitingForClick = false;
            if (this.trackId && this.blocked && settings().enabled) this.resume();
        };
        document.addEventListener('pointerdown', resume, { once: true, capture: true });
    }

    #onTime(index) {
        if (index !== this.active || this.paused || this.looping || !this.url) return;
        const deck = this.decks[index];
        const duration = deck.duration;
        if (!Number.isFinite(duration) || duration < LOOP_FADE_S * 4) return;
        if (duration - deck.currentTime <= LOOP_FADE_S) {
            this.looping = true;
            this.play(this.trackId, this.url, LOOP_FADE_S).catch(error => console.warn('[BlueMetal] loop failed', error));
        }
    }

    #onEnded(index) {
        // Safety net for very short audio, where the crossfade never starts.
        if (index !== this.active || this.paused || !this.url) return;
        this.play(this.trackId, this.url, 0.5).catch(() => {});
    }

    async #onError(index) {
        // An expired link: fetch a fresh one and pick up where it stopped.
        const deck = this.decks[index];
        if (index !== this.active || !this.trackId || this.retrying) return;
        this.retrying = true;
        const position = deck.currentTime || 0;
        try {
            const url = await audioUrl(this.trackId, { fresh: true });
            this.url = url;
            deck.src = url;
            deck.currentTime = position;
            if (!this.paused) await deck.play();
        } catch (error) {
            console.warn('[BlueMetal] could not reload the track', error);
        } finally {
            this.retrying = false;
        }
    }

    #fadeOut(deck, seconds, clear = false) {
        if (deck.paused) {
            if (clear) deck.removeAttribute('src');
            return;
        }
        this.#fade(deck, 0, seconds, () => {
            if (deck === this.decks[this.active] && !this.paused) return;
            deck.pause();
            if (clear) deck.removeAttribute('src');
            // Buffer the playing track here too, so the next loop starts at once.
            else if (this.url && deck.src !== this.url) deck.src = this.url;
        });
    }

    #cancelFade(deck) {
        clearInterval(this.fades.get(deck));
        this.fades.delete(deck);
    }

    // Equal-power curve, so a crossfade keeps the same loudness throughout.
    #fade(deck, target, seconds, done = () => {}) {
        this.#cancelFade(deck);
        const from = deck.volume;
        if (seconds <= 0 || from === target) {
            deck.volume = target;
            done();
            return;
        }
        const started = performance.now();
        const timer = setInterval(() => {
            const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
            const curve = target > from ? Math.sin(t * Math.PI / 2) : 1 - Math.cos(t * Math.PI / 2);
            // A volume change during a fade-in moves its target too.
            const goal = target > from ? this.volume : target;
            deck.volume = Math.min(1, Math.max(0, from + (goal - from) * curve));
            if (t >= 1) {
                this.#cancelFade(deck);
                done();
            }
        }, 50);
        this.fades.set(deck, timer);
    }
}

const player = new LoopPlayer();

async function playTrack(track, fadeSeconds = SWITCH_FADE_S) {
    const lib = chatLibrary();
    lib.current = track.id;
    saveChatLibrary();
    const url = await audioUrl(track.id);
    if (!settings().enabled) {
        renderStatus();
        return;
    }
    await player.play(track.id, url, fadeSeconds);
}

// ------------------------------------------------------- scene to prompt

const job = { active: null, timer: null };
const auto = { replies: 0, checking: false };

function isGenerating() {
    const stop = document.getElementById('mes_stop');
    return Boolean(stop && getComputedStyle(stop).display !== 'none');
}

function sceneInstruction(tracks) {
    const lines = [
        '[OOC: Pause the roleplay and do not continue the story. You are choosing background music for the scene as it is right now.',
        'Reply in exactly this format and nothing else:',
        'PLACE: <where the scene happens, 1-4 words>',
        'MOOD: <the mood of the scene, 1-3 words>',
    ];
    if (tracks.length) {
        lines.push('TRACK: <the number of a track below that still fits this scene, or NEW>');
    }
    lines.push('MUSIC: <one line, under 40 words: genre, tempo, instruments and feel of instrumental background music for this scene. No names, no lyrics, no singing.>');
    if (tracks.length) {
        lines.push('Tracks already made for this chat:');
        tracks.forEach((track, i) => lines.push(`${i + 1}. ${track.place || '?'} / ${track.mood || '?'}: ${track.prompt.slice(0, 100)}`));
    }
    lines.push(']');
    return lines.join('\n');
}

function parseScene(text) {
    const clean = String(text ?? '').replace(/\r/g, '');
    const grab = label => {
        const match = clean.match(new RegExp(`^[\\s>*_#-]*${label}[\\s*_]*:[\\s*_]*(.+)$`, 'im'));
        return (match?.[1] ?? '').replace(/[*_`"]/g, '').replace(/^<|>$/g, '').trim();
    };
    // Labels stay short even when the model writes a sentence.
    const label = value => value.split(/[,;.(]/)[0].replace(/^(a|an|the)\s+/i, '').split(/\s+/).slice(0, 5).join(' ').slice(0, 48);
    return {
        place: label(grab('PLACE')),
        mood: label(grab('MOOD')),
        track: grab('TRACK'),
        music: grab('MUSIC').slice(0, 400),
    };
}

function buildPrompt(scene) {
    let music = scene.music;
    if (!music) {
        music = [scene.mood, scene.place].filter(Boolean).join(' ') || 'calm atmospheric';
        music += ' background music';
    }
    music = music.replace(/[\s.,;]+$/, '');
    if (!/instrumental, no vocals$/i.test(music)) music += `, ${SUFFIX}`;
    return music.slice(0, 1900);
}

const norm = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();

async function readScene(tracks) {
    const generateQuietPrompt = ctx().generateQuietPrompt;
    // No response length cap: reasoning models spend part of it on thinking.
    const text = await generateQuietPrompt({ quietPrompt: sceneInstruction(tracks), removeReasoning: true });
    return parseScene(text);
}

async function confirmPrompt(prompt) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    const content = `
        <h3>Score this scene</h3>
        <p class="bm-popup-note">BlueMetal makes an original track from this prompt. ${money(PRICE_USD)}, usually ready in about a minute. Edit it if you like.</p>`;
    const result = await callGenericPopup(content, POPUP_TYPE.INPUT, prompt, { okButton: 'Make track', cancelButton: 'Cancel', rows: 4, wide: false });
    if (typeof result !== 'string') return null;
    return result.trim().slice(0, 2000) || null;
}

/**
 * Makes a track for the open chat and crossfades to it. Resolves with the
 * finished track, or null if nothing was made.
 */
async function makeTrack(prompt, scene = {}, { quiet = false } = {}) {
    const forChat = chatId();
    if (!forChat) throw new BlueMetalError('no_chat', 'Open a chat first.');
    if (job.active) throw new BlueMetalError('busy_job', 'A track is already being made. It will play when it is ready.');

    job.active = { chatId: forChat, prompt, started: Date.now(), status: 'queued' };
    job.timer = setInterval(renderStatus, 1000);
    renderStatus();
    if (!quiet) toastr.info('Usually ready in about a minute; the current music keeps playing.', 'BlueMetal: making a track');

    try {
        const generation = await generate(prompt, g => {
            if (!job.active) return;
            job.active.status = g.status;
        });
        urlCache.set(generation.id, { url: generation.audio.url, at: Date.now() });
        const track = {
            id: generation.id,
            prompt,
            place: scene.place || '',
            mood: scene.mood || '',
            created: Date.now(),
            duration: generation.audio.duration ?? null,
        };

        if (chatId() !== forChat) {
            const s = settings();
            (s.pending[forChat] ||= []).push(track);
            saveSettings();
            toastr.info('The track is saved for the chat it was made for.', 'BlueMetal: track ready');
            return track;
        }

        addToLibrary(track);
        settings().enabled = true;
        saveSettings();
        await playTrack(track);
        refreshBalance().catch(() => {});
        if (!quiet) toastr.success(track.prompt.slice(0, 140), 'BlueMetal: now playing');
        return track;
    } finally {
        clearInterval(job.timer);
        job.active = null;
        renderAll();
    }
}

function reportError(error) {
    const message = error?.message || String(error);
    console.warn('[BlueMetal]', error);
    if (error?.code === 'no_credit') {
        toastr.error(`${message} <a href="${DASHBOARD_URL}" target="_blank" rel="noopener">Open dashboard</a>`, 'BlueMetal', { escapeHtml: false });
    } else {
        toastr.error(message, 'BlueMetal');
    }
}

/** The "Score this scene" button: the model writes a prompt, you check it, BlueMetal makes it. */
async function scoreScene() {
    try {
        if (!settings().apiKey.trim()) throw new BlueMetalError('no_key', 'Add your BlueMetal API key in Extensions → BlueMetal Music.');
        if (!chatId()) throw new BlueMetalError('no_chat', 'Open a chat first.');
        if (job.active) throw new BlueMetalError('busy_job', 'A track is already being made. It will play when it is ready.');
        if (isGenerating()) throw new BlueMetalError('busy_chat', 'Wait for the current reply to finish.');

        setNote('Reading the scene…');
        let scene;
        try {
            scene = await readScene([]);
        } finally {
            setNote('');
        }
        if (!scene.music && !scene.place && !scene.mood) {
            throw new BlueMetalError('no_scene', 'The chat model did not describe the scene. Try again, or use /bluemetal with your own prompt.');
        }
        let prompt = buildPrompt(scene);
        if (settings().confirmPrompt) {
            prompt = await confirmPrompt(prompt);
            if (!prompt) return null;
        }
        auto.replies = 0;
        return await makeTrack(prompt, scene);
    } catch (error) {
        reportError(error);
        return null;
    }
}

// Auto mode: every few replies the model reports the place and mood. Nothing
// is made while the scene stays the same; an earlier track is reused when the
// model picks one; otherwise a new track is made and crossfaded in.
async function autoCheck() {
    const s = settings();
    if (!s.auto || !s.enabled || !s.apiKey.trim() || job.active || auto.checking || !chatId()) return;
    auto.checking = true;
    auto.replies = 0;
    try {
        for (let i = 0; i < 120 && isGenerating(); i++) await sleep(500);
        if (isGenerating()) return;

        const lib = chatLibrary();
        const tracks = lib.tracks.slice();
        const current = currentTrack();
        const scene = await readScene(tracks);
        if (!scene.place && !scene.mood && !scene.music) return;

        const picked = Number.parseInt(scene.track, 10);
        if (tracks.length && Number.isInteger(picked) && tracks[picked - 1]) {
            const track = tracks[picked - 1];
            if (track.id !== current?.id || !player.playing) await playTrack(track);
            return;
        }
        if (current && norm(current.place) === norm(scene.place) && norm(current.mood) === norm(scene.mood)) {
            if (!player.playing) await playTrack(current);
            return;
        }
        await makeTrack(buildPrompt(scene), scene, { quiet: false });
    } catch (error) {
        reportError(error);
    } finally {
        auto.checking = false;
        renderStatus();
    }
}

function onMessageReceived(messageId) {
    const s = settings();
    if (!s.auto || !s.enabled) return;
    const message = ctx().chat?.[messageId];
    if (!message || message.is_user || message.is_system) return;
    auto.replies++;
    const due = auto.replies >= s.autoEvery || (!currentTrack() && !job.active);
    if (due) setTimeout(autoCheck, 500);
    renderStatus();
}

async function onChatChanged() {
    auto.replies = 0;
    mergePending();
    renderAll();
    const track = currentTrack();
    if (!track || !settings().enabled) {
        if (player.trackId) player.stop(SWITCH_FADE_S);
        return;
    }
    if (player.trackId === track.id && player.playing) return;
    try {
        await playTrack(track);
    } catch (error) {
        if (error.code !== 'gone') console.warn('[BlueMetal] could not play this chat\'s track', error);
        player.stop();
    }
}

// ---------------------------------------------------------------- the UI

function settingsHtml() {
    return `
<div id="bluemetal_settings" class="bluemetal-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>BlueMetal Music</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <p class="bm-intro">Original background music for your chats. Your chat model describes the scene, <a href="${SITE_URL}" target="_blank" rel="noopener">BlueMetal</a> makes an instrumental track (2 to 4 minutes), and it loops with a crossfade. ${money(PRICE_USD)} per track.</p>

      <label for="bm_key">BlueMetal API key</label>
      <div class="flex-container flexnowrap alignItemsCenter">
        <input id="bm_key" class="text_pole flex1" type="password" autocomplete="off" spellcheck="false" placeholder="bm_live_…">
        <div id="bm_check" class="menu_button menu_button_icon" title="Check the key and show the balance"><i class="fa-solid fa-check"></i><span>Check</span></div>
      </div>
      <small class="bm-hint"><a href="${DASHBOARD_URL}" target="_blank" rel="noopener">Get a key on bluemetal.ai</a>. New accounts get $0.10 free, about 10 tracks. <span id="bm_balance"></span></small>

      <hr class="sysHR">

      <div class="bm-player">
        <div id="bm_toggle" class="menu_button menu_button_icon" title="Play or pause"><i class="fa-solid fa-play"></i></div>
        <div class="bm-now">
          <div id="bm_now_title" class="bm-now-title">Nothing playing</div>
          <div id="bm_now_sub" class="bm-now-sub"></div>
        </div>
      </div>
      <label for="bm_volume" class="bm-volume"><i class="fa-solid fa-volume-low"></i>
        <input id="bm_volume" type="range" min="0" max="100" step="1">
        <span id="bm_volume_value"></span>
      </label>
      <div id="bm_score" class="menu_button menu_button_icon bm-score"><i class="fa-solid fa-music"></i><span>Score this scene</span></div>

      <label class="checkbox_label" for="bm_enabled"><input id="bm_enabled" type="checkbox"><span>Play music</span></label>
      <label class="checkbox_label" for="bm_confirm"><input id="bm_confirm" type="checkbox"><span>Review the prompt before Score this scene makes a track</span></label>
      <label class="checkbox_label" for="bm_auto"><input id="bm_auto" type="checkbox"><span>Auto mode: follow the scene</span></label>
      <div class="bm-auto-row">
        <span>Check the scene every</span>
        <input id="bm_auto_every" class="text_pole bm-number" type="number" min="1" max="50" step="1">
        <span>replies.</span>
      </div>
      <small class="bm-hint">Each check is one short request to your chat model. A new track is made only when the place or mood changes; tracks this chat already has are reused.</small>

      <hr class="sysHR">
      <div class="bm-library-head"><b>This chat's tracks</b></div>
      <div id="bm_library" class="bm-library"></div>
    </div>
  </div>
</div>`;
}

function setNote(text) {
    job.note = text;
    renderStatus();
}

function elapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderStatus() {
    const s = settings();
    const track = currentTrack();
    const title = $('#bm_now_title');
    const sub = $('#bm_now_sub');
    if (!title.length) return;

    if (track) {
        title.text([track.place, track.mood].filter(Boolean).join(' · ') || 'Custom track');
        title.attr('title', track.prompt);
    } else {
        title.text(chatId() ? 'Nothing playing' : 'Open a chat to add music');
        title.removeAttr('title');
    }

    let line = '';
    if (job.active) {
        const waited = Date.now() - job.active.started;
        line = job.active.status === 'queued' && waited > 30000
            ? `Waiting for a free server… ${elapsed(waited)}. This can take a few minutes.`
            : `Making a new track… ${elapsed(waited)}`;
    } else if (job.note) {
        line = job.note;
    } else if (auto.checking) {
        line = 'Checking the scene…';
    } else if (player.blocked) {
        line = 'Click anywhere to start the music';
    } else if (track && !s.enabled) {
        line = 'Music is off';
    } else if (track && player.playing) {
        line = s.auto ? `Looping. Auto mode checks the scene every ${s.autoEvery} replies.` : 'Looping';
    } else if (track) {
        line = 'Paused';
    }
    sub.text(line);

    $('#bm_toggle i').toggleClass('fa-play', !player.playing).toggleClass('fa-pause', player.playing);
    $('#bm_toggle').toggleClass('disabled', !track);
    $('#bm_score').toggleClass('disabled', Boolean(job.active));
    $('#bm_score span').text(job.active ? 'Making a track…' : 'Score this scene');
    $('#bm_wand_label').text(job.active ? 'BlueMetal: making a track…' : 'Score this scene');

    const balance = s.balance;
    $('#bm_balance').text(balance === null || balance === undefined ? '' : `Balance: ${money(balance)}, about ${Math.floor(balance / PRICE_USD + 1e-9)} tracks.`);
}

function renderLibrary() {
    const container = $('#bm_library');
    if (!container.length) return;
    const lib = chatLibrary();
    if (!chatId() || !lib.tracks.length) {
        container.html('<small class="bm-hint">None yet. Score a scene to make the first one.</small>');
        return;
    }
    const rows = lib.tracks.slice().reverse().map(track => {
        const label = [track.place, track.mood].filter(Boolean).join(' · ') || 'Custom track';
        const playing = track.id === lib.current;
        return `
<div class="bm-track${playing ? ' bm-current' : ''}" data-id="${esc(track.id)}">
  <div class="bm-track-text">
    <div class="bm-track-label">${playing ? '<i class="fa-solid fa-volume-high"></i> ' : ''}${esc(label)}</div>
    <div class="bm-track-prompt" title="${esc(track.prompt)}">${esc(track.prompt)}</div>
  </div>
  <div class="bm-track-actions">
    <div class="menu_button menu_button_icon bm-track-play" title="Play this track"><i class="fa-solid fa-play"></i></div>
    <div class="menu_button menu_button_icon bm-track-save" title="Download the MP3"><i class="fa-solid fa-download"></i></div>
    <div class="menu_button menu_button_icon bm-track-remove" title="Remove from this chat"><i class="fa-solid fa-xmark"></i></div>
  </div>
</div>`;
    });
    container.html(rows.join(''));
}

function renderAll() {
    renderStatus();
    renderLibrary();
}

function bindSettings() {
    const s = settings();
    $('#bm_key').val(s.apiKey).on('input', function () {
        settings().apiKey = String($(this).val()).trim();
        settings().balance = null;
        saveSettings();
        renderStatus();
    });
    $('#bm_check').on('click', async () => {
        try {
            await refreshBalance();
            toastr.success(`Key works. Balance: ${money(settings().balance)}.`, 'BlueMetal');
        } catch (error) {
            reportError(error);
        }
    });
    $('#bm_volume').val(s.volume).on('input', function () {
        settings().volume = Number($(this).val());
        $('#bm_volume_value').text(`${settings().volume}%`);
        player.setVolume();
        saveSettings();
    });
    $('#bm_volume_value').text(`${s.volume}%`);
    $('#bm_enabled').prop('checked', s.enabled).on('change', async function () {
        settings().enabled = $(this).prop('checked');
        saveSettings();
        if (!settings().enabled) player.pause();
        else if (currentTrack()) {
            if (player.trackId === currentTrack().id) await player.resume();
            else await playTrack(currentTrack()).catch(reportError);
        }
        renderStatus();
    });
    $('#bm_confirm').prop('checked', s.confirmPrompt).on('change', function () {
        settings().confirmPrompt = $(this).prop('checked');
        saveSettings();
    });
    $('#bm_auto').prop('checked', s.auto).on('change', function () {
        settings().auto = $(this).prop('checked');
        auto.replies = 0;
        saveSettings();
        renderStatus();
    });
    $('#bm_auto_every').val(s.autoEvery).on('change', function () {
        settings().autoEvery = Number($(this).val());
        $(this).val(settings().autoEvery);
        saveSettings();
        renderStatus();
    });
    $('#bm_toggle').on('click', async () => {
        const track = currentTrack();
        if (!track) return;
        if (player.playing) {
            player.pause();
            return;
        }
        if (!settings().enabled) {
            settings().enabled = true;
            $('#bm_enabled').prop('checked', true);
            saveSettings();
        }
        if (player.trackId === track.id) await player.resume();
        else await playTrack(track).catch(reportError);
    });
    $('#bm_score').on('click', () => {
        if (!job.active) scoreScene();
    });
    $('#bm_library')
        .on('click', '.bm-track-play', async function () {
            const track = chatLibrary().tracks.find(t => t.id === $(this).closest('.bm-track').data('id'));
            if (!track) return;
            settings().enabled = true;
            $('#bm_enabled').prop('checked', true);
            saveSettings();
            await playTrack(track).catch(reportError);
            renderAll();
        })
        .on('click', '.bm-track-save', async function () {
            const id = $(this).closest('.bm-track').data('id');
            try {
                // The link is served as a download with a file name.
                const link = document.createElement('a');
                link.href = await audioUrl(id, { fresh: true });
                link.rel = 'noopener';
                link.click();
            } catch (error) {
                reportError(error);
            }
        })
        .on('click', '.bm-track-remove', function () {
            const id = $(this).closest('.bm-track').data('id');
            if (player.trackId === id) player.stop();
            removeFromLibrary(id);
            renderAll();
        });
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('bm_wand')) return;
    const item = document.createElement('div');
    item.id = 'bm_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = 'Make background music for this scene with BlueMetal';
    item.innerHTML = '<div class="fa-solid fa-music extensionsMenuExtensionButton"></div><span id="bm_wand_label">Score this scene</span>';
    item.addEventListener('click', () => {
        if (!job.active) scoreScene();
    });
    menu.append(item);
}

function addSlashCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bluemetal',
        returns: 'the generation id of the track that is playing',
        helpString: `
            <div>Background music with BlueMetal (${money(PRICE_USD)} per track).</div>
            <ul>
                <li><code>/bluemetal</code> asks the chat model for a prompt that fits the scene, then makes and plays the track.</li>
                <li><code>/bluemetal slow jazz piano in a rainy bar</code> makes a track from your own prompt, as written.</li>
                <li><code>/bluemetal stop</code>, <code>/bluemetal pause</code> and <code>/bluemetal play</code> control the music.</li>
            </ul>`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'a music prompt, or stop / pause / play',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        callback: async (_args, value) => {
            const text = String(value ?? '').trim();
            const word = text.toLowerCase();
            if (word === 'stop') {
                player.stop();
                return '';
            }
            if (word === 'pause') {
                player.pause();
                return player.trackId ?? '';
            }
            if (word === 'play' || word === 'resume') {
                const track = currentTrack();
                if (track && player.trackId === track.id) await player.resume();
                else if (track) await playTrack(track).catch(reportError);
                return track?.id ?? '';
            }
            if (!text) {
                const track = await scoreScene();
                return track?.id ?? '';
            }
            try {
                const track = await makeTrack(text.slice(0, 2000), {});
                return track?.id ?? '';
            } catch (error) {
                reportError(error);
                return '';
            }
        },
    }));
}

function init() {
    settings();
    const target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    target.append(settingsHtml());
    bindSettings();
    addWandButton();
    addSlashCommand();
    player.onChange = () => renderAll();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    renderAll();
    if (settings().apiKey) refreshBalance().catch(() => {});
}

jQuery(() => {
    try {
        init();
    } catch (error) {
        console.error('[BlueMetal] failed to load', error);
    }
});
