// ==UserScript==
// @name         Mouse Path Recorder (local prototype)
// @namespace    boid-brush.prototype.mouse-path
// @version      0.4.1
// @description  Record and replay mouse events on this page for local testing.
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://gigigugit.github.io/boid_brush/app.html
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

// Change @match to the specific site you intend to test before installing elsewhere.
// Toggle recording with Ctrl+Shift+Alt+M (change SHORTCUT below), or use the panel.
// Stop recording before playing. Add saved paths to the sequence to run them in
// order; set each step's speed and optionally loop the whole sequence. The Speed
// selector multiplies all steps. With no steps, Play runs the current path.
// Click mode replays the recorded app lifecycle. Timeline mode crops/rebases one
// canvas stroke and independently schedules Boid spawn and first paint stamp.
// Save and Load manage named paths; Export downloads JSON; Import loads JSON;
// Clear confirms first.
// All moves are recorded (no throttling). Large drags can produce large files.
// Replay dispatches synthetic events (isTrusted === false); browsers and apps may
// ignore them. Canvas drags use synthetic pointer events; they cannot capture a
// real browser pointer or reproduce browser-default actions or privileged input.

(() => {
    'use strict';

    const ROOT_ID = 'mouse-path-recorder-prototype';
    const CLEANUP_KEY = '__mousePathRecorderPrototypeCleanup';
    const STORAGE_KEY = 'mouse-path-recorder-prototype.paths.v1';
    const BRIDGE_EVENT = 'mouse-path-recorder-prototype:replay';
    const BRIDGE_CLEANUP_EVENT = 'mouse-path-recorder-prototype:cleanup';
    const BRIDGE_RESULT = 'data-mouse-path-replay-result';
    const SHORTCUT = { key: 'm', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false };
    const EVENT_TYPES = new Set(['mousedown', 'mousemove', 'mouseup', 'click']);
    const POINTER_TYPES = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup' };
    const MAX_EVENTS = 200000;
    const SAVED_PATH_VERSION = 2;
    const TRIM_WARNING_KEY = 'mouse-path-recorder-prototype.skip-trim-warning.v1';
    const mousePath = [];
    const sequenceSteps = [];
    let recording = false;
    let recordingStart = 0;
    let playing = false;
    let cancelled = false;
    let timer = null;
    let wakeTimer = null;
    let lastCountUpdate = 0;
    let directPlaybackActive = false;
    let timelineSettings = createTimelineSettings([], false);
    let timelineDrawerOpen = false;
    let recorderMinimized = false;

    if (typeof globalThis[CLEANUP_KEY] === 'function') globalThis[CLEANUP_KEY]();
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement('div');
    root.id = ROOT_ID;

    // may have to re-add css style for timeline drawer. It is:  
    // .timeline-drawer { position: absolute; right: 250px; bottom: 0; width: 1048px; height: 40%; min-height: 238px; box-sizing: border-box; padding: 10px; background: #101b21; border: 1px solid #45606a; border-right: 0; border-radius: 6px 0 0 6px; box-shadow: -8px 6px 24px #0009; display: none; overflow-y: auto; } 

    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
        <style>
            :host { all: initial; position: fixed; right: 12px; top: calc(var(--topbar-h, 44px) + 12px); bottom: 15px; z-index: 2147483646; font: 12px/1.4 ui-sans-serif, sans-serif; color: #e6edf2; }
            :host(.minimized) { bottom: auto; }
            .panel { width: 250px; height: 100%; box-sizing: border-box; padding: 10px; background: #18232a; border: 1px solid #45606a; border-radius: 6px; box-shadow: 0 6px 24px #0009; display: flex; flex-direction: column; }
            .panel.minimized { width: auto; height: auto; padding: 4px; }
            .panel-head { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
            .panel-head .title { margin: 0; flex: 1; }
            .panel-head #minimizeButton { flex: none; width: auto; }
            .panel-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
            .compact-actions { display: none; align-items: center; gap: 4px; }
            .compact-actions button { flex: none; min-width: 30px; white-space: nowrap; }
            .panel.minimized .panel-head { margin: 0; }
            .panel.minimized .panel-head .title, .panel.minimized .panel-body { display: none; }
            .panel.minimized .compact-actions { display: flex; }
            .title { font-weight: 700; margin-bottom: 8px; }
            .row { display: flex; align-items: center; gap: 5px; margin: 6px 0; }
            button, select, input { box-sizing: border-box; font: inherit; color: inherit; background: #263b44; border: 1px solid #55727b; border-radius: 4px; padding: 4px; min-width: 0; }
            button { cursor: pointer; flex: 1; }
            button:disabled { opacity: .45; cursor: default; }
            input[type=text], select { flex: 1; }
            .active { background: #9b3838; color: white; }
            .status { min-height: 2.8em; overflow-wrap: anywhere; color: #b9d4dc; }
            .error { color: #ffb9aa; }
            .count { margin-left: auto; font-variant-numeric: tabular-nums; }
            .sequence { flex: 1; min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid #45606a; margin-bottom: 8px; }
            .sequence-list { flex: 1; min-height: 0; overflow-y: auto; }
            .sequence-step { display: flex; align-items: center; gap: 4px; margin: 5px 0; }
            .sequence-step select:first-child { flex: 1; min-width: 0; }
            .sequence-step select:nth-child(2) { width: 52px; flex: none; }
            .sequence-step button { flex: none; width: 24px; }
            .sequence-step.running { background: #31545e; }
            #addStep { flex: none; }
            #loopCount { width: 54px; flex: none; }
            .controls { flex: none; max-height: 65%; overflow-y: auto; }
            .spawn-options { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
            .spawn-options label { min-width: 0; }
            .spawn-options input, .spawn-options select { width: 100%; }

            .timeline-drawer {
                position: absolute;
                right: 250px;
                bottom: 0;
                width: 1048px;
                height: 45%;
                min-height: 238px;
                box-sizing: border-box;
                padding: 10px;
                background: #27414f;
                /* border: 1px solid #45606a; */
                border-right: 0;
                border-radius: 6px 0 0 6px;
                box-shadow: -8px 6px 24px #0009;
                display: none;
                overflow-y: auto;
            }


            .timeline-drawer.open { display: block; }
            .timeline-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .timeline-mode { display: flex; align-items: center; gap: 5px; flex: 1; }
            .timeline-mode input { flex: none; }
            .timeline-summary { color: #9eb9c3; font-variant-numeric: tabular-nums; }
            .timeline-graph { position: relative; height: 72px; margin: 13px 8px 8px; touch-action: none; }
            .timeline-rail { position: absolute; left: 0; right: 0; top: 33px; height: 4px; background: #49606a; border-radius: 2px; }
            .timeline-crop { position: absolute; top: 0; bottom: 0; background: #56b6c244; border-left: 1px solid #7adce7; border-right: 1px solid #7adce7; pointer-events: none; }
            .timeline-handle { position: absolute; top: 5px; width: 22px; height: 55px; transform: translateX(-50%); padding: 0; border: 0; background: transparent; color: #e6edf2; overflow: visible; cursor: ew-resize; }
            .timeline-handle::after { content: ''; position: absolute; left: 9px; top: 19px; width: 4px; height: 28px; border-radius: 2px; background: var(--handle-color); box-shadow: 0 0 0 1px #071014; }
            .timeline-handle span { position: absolute; top: 0; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: 10px; color: var(--handle-color); }
            .timeline-handle[data-field="trimStart"], .timeline-handle[data-field="trimEnd"] { --handle-color: #d6e1e5; }
            .timeline-handle[data-field="spawnAt"] { --handle-color: #ffb454; }
            .timeline-handle[data-field="stampAt"] { --handle-color: #69d58c; }
            .timeline-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 8px; }
            .timeline-fields label { display: grid; grid-template-columns: 1fr 72px; align-items: center; gap: 4px; }
            .timeline-fields input, .timeline-fields select { width: 100%; }
            .timeline-dialog-backdrop { position: absolute; inset: 0; background: #000a; display: none; align-items: center; justify-content: center; z-index: 3; }
            .timeline-dialog-backdrop.open { display: flex; }
            .timeline-dialog { width: 240px; padding: 12px; background: #182a32; border: 1px solid #63808b; border-radius: 6px; }
            .timeline-dialog p { margin: 0 0 10px; }
            .timeline-dialog label { display: block; margin-bottom: 8px; }
            @media (max-width: 640px) { .timeline-drawer { position: fixed; left: 8px; right: 8px; bottom: 8px; width: auto; height: 38%; border-right: 1px solid #45606a; border-radius: 6px; } }
        </style>
        <div class="panel">
            <div class="panel-head">
                <span class="title">Point recorder</span>
                <div class="compact-actions" aria-label="Point recorder controls">
                    <button id="compactRecord" type="button" title="Record" aria-label="Record">●</button>
                    <button id="compactPlay" type="button" title="Start playback">▶ Start</button>
                    <button id="compactStop" type="button" title="Stop recording or playback">⏹ Stop</button>
                    <button id="compactSave" type="button" title="Save path" aria-label="Save path">💾</button>
                </div>
                <button id="minimizeButton" type="button" aria-expanded="true" title="Minimize point recorder">◀ Hide</button>
            </div>
            <div class="panel-body">
                <div class="sequence">
                    <div class="row"><span class="title">Sequence</span><button id="addStep" type="button" title="Add saved path">+ Path</button></div>
                    <div id="sequenceList" class="sequence-list" role="list"></div>
                    <div class="row"><label for="loopCount">Repeat</label><select id="loopCount"><option value="1">Once</option><option value="2">2 times</option><option value="3">3 times</option><option value="0">Until stopped</option></select></div>
                </div>
                <div class="controls">
                    <div class="row"><span class="title">Mouse path</span><span class="count" id="count">0 events</span></div>
                    <div class="row"><button id="record" type="button">Record</button><button id="play" type="button">Play</button><button id="stop" type="button" disabled>Stop</button></div>
                    <div class="row"><label for="speed">Speed</label><select id="speed"><option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option></select></div>
                    <div class="row"><button id="timelineButton" type="button" title="Set and use stroke timeline">Timeline</button><label class="timeline-mode"><input id="timelineEnabled" type="checkbox"> Use stroke timeline</label></div>
                    <div class="row"><input id="name" type="text" maxlength="80" placeholder="Path name" aria-label="Path name"><button id="save" type="button">Save</button></div>
                    <div class="row"><select id="saved" aria-label="Saved paths"><option value="">Saved paths</option></select><button id="load" type="button">Load</button></div>
                    <div class="row"><button id="export" type="button">Export</button><button id="import" type="button">Import</button><button id="clear" type="button">Clear</button></div>
                    <input id="file" type="file" accept=".json,application/json" hidden>
                    <div id="status" class="status" role="status" aria-live="polite">Idle</div>
                </div>
            </div>
        </div>
        <section id="timelineDrawer" class="timeline-drawer" aria-label="Stroke timeline">
            <div class="timeline-head"><strong>Stroke timeline</strong><span id="timelineSummary" class="timeline-summary">No stroke</span></div>
            <div id="timelineGraph" class="timeline-graph" aria-label="Timeline handles">
                <div class="timeline-rail"></div><div id="timelineCrop" class="timeline-crop"></div>
                <button class="timeline-handle" data-field="trimStart" type="button"><span>Trim start</span></button>
                <button class="timeline-handle" data-field="spawnAt" type="button"><span>Spawn</span></button>
                <button class="timeline-handle" data-field="stampAt" type="button"><span>Stamp</span></button>
                <button class="timeline-handle" data-field="trimEnd" type="button"><span>Trim end</span></button>
            </div>
            <div class="timeline-fields">
                <label>Trim start<input id="trimStart" type="number" min="0" step="1"></label>
                <label>Trim end<input id="trimEnd" type="number" min="0" step="1"></label>
                <label>Spawn<input id="spawnAt" type="number" min="0" step="1"></label>
                <label>Stamp start<input id="stampAt" type="number" min="0" step="1"></label>
                <label>Position<select id="spawnPosition"><option value="path">Path at spawn</option><option value="click">Recorded press</option></select></label>
                <label>X offset<input id="spawnX" type="number" min="-1000" max="1000" step="1"></label>
                <label>Y offset<input id="spawnY" type="number" min="-1000" max="1000" step="1"></label>
            </div>
            <div id="timelineDialogBackdrop" class="timeline-dialog-backdrop">
                <div class="timeline-dialog" role="dialog" aria-modal="true" aria-labelledby="timelineDialogTitle">
                    <strong id="timelineDialogTitle">Move timeline markers?</strong>
                    <p>This trim will move your existing Spawn or Stamp Start point.</p>
                    <label><input id="skipTrimWarning" type="checkbox"> Do not ask me again</label>
                    <div class="row"><button id="timelineCancel" type="button">Cancel</button><button id="timelineConfirm" type="button">OK</button></div>
                </div>
            </div>
        </section>`;
    const get = (id) => shadow.getElementById(id);
    const indicator = document.createElement('div');
    indicator.setAttribute('aria-hidden', 'true');
    Object.assign(indicator.style, {
        position: 'fixed', width: '16px', height: '16px', border: '2px solid #ff6b52',
        borderRadius: '50%', background: '#ff6b5244', pointerEvents: 'none',
        zIndex: '2147483647', display: 'none', transform: 'translate(-50%, -50%)'
    });
    document.documentElement.append(root, indicator);

    // The app's pointer-capture call runs in the page world, not Tampermonkey's sandbox.
    const bridgeScript = document.createElement('script');
    bridgeScript.textContent = `(() => {
        const onReplay = event => {
            const target = event.target;
            if (target?.id !== 'interactionCanvas') return;
            let result = 'ok';
            try {
                const { type, options } = JSON.parse(event.detail);
                if (type === 'end') {
                    target.dispatchEvent(new CustomEvent('boid-brush:recorder-end'));
                    target.setAttribute('${BRIDGE_RESULT}', result);
                    return;
                }
                if (type === 'spawn' || type === 'stamp' || type === 'check') {
                    if (type === 'spawn' && (!Number.isFinite(options.clientX) || !Number.isFinite(options.clientY))) throw new Error('Invalid spawn coordinates.');
                    if (type === 'stamp' && (!Number.isFinite(options.clientX) || !Number.isFinite(options.clientY))) throw new Error('Invalid stamp coordinates.');
                    const detail = { clientX: options.clientX, clientY: options.clientY,
                        deferStamp: options.deferStamp === true, accepted: false };
                    target.dispatchEvent(new CustomEvent('boid-brush:recorder-' + type, { detail }));
                    if (!detail.accepted) {
                        throw new Error(detail.reason || 'App recorder hook not found. Load the updated Boid Brush app and reload the page.');
                    }
                    target.setAttribute('${BRIDGE_RESULT}', result);
                    return;
                }
                if (!['pointerdown', 'pointermove', 'pointerup'].includes(type)) throw new Error('Invalid pointer event.');
                const priorCapture = Object.getOwnPropertyDescriptor(target, 'setPointerCapture');
                const capture = target.setPointerCapture;
                if (type === 'pointerdown') {
                    target.setPointerCapture = function (pointerId) {
                        try { return capture.call(this, pointerId); }
                        catch (error) { if (error.name !== 'NotFoundError' || pointerId !== options.pointerId) throw error; }
                    };
                }
                try {
                    const pointer = new PointerEvent(type, options);
                    if (type === 'pointerdown' && options.recorderDeferSpawn === true) {
                        Object.defineProperty(pointer, 'recorderDeferSpawn', { value: true });
                    }
                    target.dispatchEvent(pointer);
                }
                finally {
                    if (type === 'pointerdown') {
                        if (priorCapture) Object.defineProperty(target, 'setPointerCapture', priorCapture);
                        else delete target.setPointerCapture;
                    }
                }
            } catch (error) { result = error.message; }
            target.setAttribute('${BRIDGE_RESULT}', result);
        };
        document.addEventListener('${BRIDGE_EVENT}', onReplay, true);
        document.addEventListener('${BRIDGE_CLEANUP_EVENT}', () => {
            document.removeEventListener('${BRIDGE_EVENT}', onReplay, true);
        }, { once: true });
    })();`;
    document.documentElement.append(bridgeScript);
    bridgeScript.remove();

    function message(text, error = false) {
        get('status').textContent = text;
        get('status').classList.toggle('error', error);
    }

    function timelineDuration() {
        try { return getCanvasStroke(mousePath).duration; } catch { return 0; }
    }

    function confirmMarkerMove() {
        if (GM_getValue(TRIM_WARNING_KEY, false) === true) return Promise.resolve(true);
        const backdrop = get('timelineDialogBackdrop');
        backdrop.classList.add('open');
        get('skipTrimWarning').checked = false;
        get('timelineConfirm').focus();
        return new Promise(resolve => {
            const finish = accepted => {
                get('timelineConfirm').removeEventListener('click', confirm);
                get('timelineCancel').removeEventListener('click', cancel);
                backdrop.classList.remove('open');
                if (accepted && get('skipTrimWarning').checked) GM_setValue(TRIM_WARNING_KEY, true);
                resolve(accepted);
            };
            const confirm = () => finish(true);
            const cancel = () => finish(false);
            get('timelineConfirm').addEventListener('click', confirm);
            get('timelineCancel').addEventListener('click', cancel);
        });
    }

    function renderTimeline() {
        get('timelineDrawer').classList.toggle('open', timelineDrawerOpen && !recorderMinimized);
        get('timelineButton').classList.toggle('active', timelineDrawerOpen);
        get('timelineButton').setAttribute('aria-expanded', String(timelineDrawerOpen));
        get('timelineEnabled').checked = timelineSettings.enabled === true;
        const duration = timelineDuration();
        const valid = duration > 0;
        if (valid) timelineSettings = normalizeTimelineSettings(mousePath, timelineSettings);
        const disabled = !valid || playing || recording;
        get('timelineEnabled').disabled = disabled;
        for (const id of ['trimStart', 'trimEnd', 'spawnAt', 'stampAt', 'spawnPosition', 'spawnX', 'spawnY']) {
            get(id).disabled = disabled;
        }
        for (const handle of get('timelineGraph').querySelectorAll('.timeline-handle')) handle.disabled = disabled;
        if (!valid) {
            get('timelineSummary').textContent = 'No valid stroke';
            return;
        }
        const effectiveDuration = timelineSettings.trimEnd - timelineSettings.trimStart;
        get('timelineSummary').textContent = `${Math.round(effectiveDuration)} ms`;
        get('trimStart').value = String(Math.round(timelineSettings.trimStart));
        get('trimEnd').value = String(Math.round(timelineSettings.trimEnd));
        get('spawnAt').value = String(Math.round(timelineSettings.spawnAt - timelineSettings.trimStart));
        get('stampAt').value = String(Math.round(timelineSettings.stampAt - timelineSettings.trimStart));
        for (const id of ['trimStart', 'trimEnd']) get(id).max = String(Math.round(duration));
        for (const id of ['spawnAt', 'stampAt']) get(id).max = String(Math.round(effectiveDuration));
        get('spawnPosition').value = timelineSettings.position;
        get('spawnX').value = String(timelineSettings.x);
        get('spawnY').value = String(timelineSettings.y);
        for (const handle of get('timelineGraph').querySelectorAll('.timeline-handle')) {
            const value = timelineSettings[handle.dataset.field];
            handle.style.left = `${duration ? value / duration * 100 : 0}%`;
            const shown = handle.dataset.field === 'spawnAt' || handle.dataset.field === 'stampAt'
                ? value - timelineSettings.trimStart : value;
            handle.querySelector('span').textContent = `${handle.dataset.field === 'trimStart' ? 'Start' : handle.dataset.field === 'trimEnd' ? 'End' : handle.dataset.field === 'spawnAt' ? 'Spawn' : 'Stamp'} ${Math.round(shown)}`;
        }
        const crop = get('timelineCrop');
        crop.style.left = `${timelineSettings.trimStart / duration * 100}%`;
        crop.style.right = `${(duration - timelineSettings.trimEnd) / duration * 100}%`;
    }

    async function setTimelineField(field, rawValue) {
        const duration = timelineDuration();
        if (!duration || playing || recording || !Number.isFinite(rawValue)) return renderTimeline();
        const previous = { ...timelineSettings };
        if (field === 'trimStart') {
            const next = Math.max(0, Math.min(timelineSettings.trimEnd - 1, rawValue));
            const crosses = next > timelineSettings.spawnAt || next > timelineSettings.stampAt;
            if (crosses && !await confirmMarkerMove()) return renderTimeline();
            timelineSettings.trimStart = next;
            timelineSettings.spawnAt = Math.max(next, timelineSettings.spawnAt);
            timelineSettings.stampAt = Math.max(timelineSettings.spawnAt, timelineSettings.stampAt);
        } else if (field === 'trimEnd') {
            const next = Math.min(duration, Math.max(timelineSettings.trimStart + 1, rawValue));
            const crosses = next < timelineSettings.spawnAt || next < timelineSettings.stampAt;
            if (crosses && !await confirmMarkerMove()) return renderTimeline();
            timelineSettings.trimEnd = next;
            timelineSettings.spawnAt = Math.min(next, timelineSettings.spawnAt);
            timelineSettings.stampAt = Math.min(next, Math.max(timelineSettings.spawnAt, timelineSettings.stampAt));
        } else if (field === 'spawnAt') {
            timelineSettings.spawnAt = Math.max(timelineSettings.trimStart,
                Math.min(timelineSettings.stampAt, timelineSettings.trimStart + rawValue));
        } else if (field === 'stampAt') {
            timelineSettings.stampAt = Math.max(timelineSettings.spawnAt,
                Math.min(timelineSettings.trimEnd, timelineSettings.trimStart + rawValue));
        }
        timelineSettings = normalizeTimelineSettings(mousePath, timelineSettings);
        if (!Number.isFinite(timelineSettings.trimEnd)) timelineSettings = previous;
        renderTimeline();
    }

    function updateControls() {
        get('record').textContent = recording ? 'Recording...' : 'Record';
        get('record').classList.toggle('active', recording);
        get('record').disabled = playing;
        get('play').disabled = playing || recording || (!mousePath.length && !sequenceSteps.length);
        get('stop').disabled = !playing && !recording;
        for (const id of ['save', 'load', 'import', 'export', 'clear']) get(id).disabled = playing || recording;
        get('addStep').disabled = playing || recording;
        get('loopCount').disabled = playing || recording;
        for (const control of get('sequenceList').querySelectorAll('button, select')) control.disabled = playing || recording;
        get('speed').disabled = playing;
        get('count').textContent = `${mousePath.length} events`;
        get('compactRecord').classList.toggle('active', recording);
        get('compactRecord').disabled = playing;
        get('compactPlay').disabled = playing || recording || (!mousePath.length && !sequenceSteps.length);
        get('compactStop').disabled = !playing && !recording;
        get('compactSave').disabled = playing || recording || !mousePath.length;
        renderTimeline();
    }

    function setRecorderMinimized(minimized) {
        recorderMinimized = minimized;
        root.classList.toggle('minimized', minimized);
        shadow.querySelector('.panel').classList.toggle('minimized', minimized);
        const button = get('minimizeButton');
        button.textContent = minimized ? '▶ Show' : '◀ Hide';
        button.title = minimized ? 'Maximize point recorder' : 'Minimize point recorder';
        button.setAttribute('aria-expanded', String(!minimized));
        renderTimeline();
    }

    function saveFromCompactControls() {
        if (!get('name').value.trim()) {
            setRecorderMinimized(false);
            get('name').focus();
            message('Enter a path name before saving.', true);
            return;
        }
        save();
    }

    function identifyTarget(element) {
        if (!(element instanceof Element)) return null;
        const tagName = element.localName;
        if (element.id) return { selector: `#${CSS.escape(element.id)}`, tagName };
        for (const attribute of ['data-testid', 'aria-label', 'name']) {
            const value = element.getAttribute(attribute);
            if (value && /^[a-zA-Z0-9_.: -]{1,80}$/.test(value)) {
                const selector = `${tagName}[${attribute}="${value}"]`;
                if (document.querySelectorAll(selector).length === 1) return { selector, tagName };
            }
        }
        const parts = [];
        for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
            const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [];
            parts.unshift(`${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`);
        }
        return { selector: `html > ${parts.join(' > ')}`, tagName };
    }

    function validatePath(path) {
        if (!Array.isArray(path) || path.length > MAX_EVENTS) throw new Error('Path must be an array of at most 200000 events.');
        let previous = 0;
        for (const [index, entry] of path.entries()) {
            if (!entry || typeof entry !== 'object' || !EVENT_TYPES.has(entry.type) ||
                !Number.isFinite(entry.x) || entry.x < 0 || !Number.isFinite(entry.y) || entry.y < 0 ||
                !Number.isFinite(entry.timestamp) || entry.timestamp < previous || entry.timestamp < 0 ||
                !entry.modifiers || typeof entry.modifiers !== 'object' ||
                !['shiftKey', 'ctrlKey', 'altKey', 'metaKey'].every(key => typeof entry.modifiers[key] === 'boolean') ||
                !Number.isInteger(entry.button) || entry.button < (entry.type === 'mousemove' ? -1 : 0) || entry.button > 4 ||
                !Number.isInteger(entry.buttons) || entry.buttons < 0 || entry.buttons > 31 ||
                !entry.target || typeof entry.target !== 'object' ||
                typeof entry.target.selector !== 'string' || !entry.target.selector || entry.target.selector.length > 1024 ||
                typeof entry.target.tagName !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.target.tagName)) {
                throw new Error(`Invalid event at position ${index + 1}.`);
            }
            previous = entry.timestamp;
        }
        return path;
    }

    function onMouse(event) {
        if (!recording || !event.isTrusted || event.composedPath().includes(root)) return;
        const onCanvas = event.target === document.getElementById('interactionCanvas');
        if (event.type in POINTER_TYPES) {
            if (!onCanvas || event.pointerType !== 'mouse') return;
        } else if (onCanvas && event.type !== 'click') return;
        if (mousePath.length >= MAX_EVENTS) {
            stopRecording();
            message('Recording stopped: 200000-event limit reached.', true);
            return;
        }
        const target = identifyTarget(event.target);
        if (!target) return;
        mousePath.push({
            type: POINTER_TYPES[event.type] || event.type, x: event.clientX, y: event.clientY,
            timestamp: Math.max(0, performance.now() - recordingStart),
            modifiers: { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey },
            button: event.button, buttons: event.buttons, target
        });
        if (performance.now() - lastCountUpdate > 100) {
            lastCountUpdate = performance.now();
            updateControls();
        }
    }

    function stopRecording() {
        recording = false;
        timelineSettings = createTimelineSettings(mousePath, false);
        updateControls();
        message(`Recorded ${mousePath.length} events.`);
    }

    function toggleRecording() {
        if (playing) return;
        if (recording) return stopRecording();
        mousePath.length = 0;
        timelineSettings = createTimelineSettings([], false);
        recordingStart = performance.now();
        lastCountUpdate = 0;
        recording = true;
        updateControls();
        message('Recording on this page...');
    }

    function onKeyDown(event) {
        if (event.composedPath().some(node => node instanceof Element &&
            (node.matches('input, textarea, select, [contenteditable]') || node.isContentEditable))) return;
        if (event.key.toLowerCase() !== SHORTCUT.key ||
            ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'].some(key => event[key] !== SHORTCUT[key]) || event.repeat) return;
        event.preventDefault();
        toggleRecording();
    }

    function resolveTarget(target) {
        let element;
        try { element = document.querySelector(target.selector); } catch { return null; }
        if (element?.localName !== target.tagName || element === root || root.contains(element)) return null;
        return element;
    }

    function showIndicator(x, y) {
        indicator.style.left = `${x}px`;
        indicator.style.top = `${y}px`;
        indicator.style.display = 'block';
        const rect = indicator.getBoundingClientRect();
        indicator.style.left = `${x + x - (rect.left + rect.width / 2)}px`;
        indicator.style.top = `${y + y - (rect.top + rect.height / 2)}px`;
    }

    function dispatchCanvasCommand(canvas, type, options) {
        canvas.removeAttribute(BRIDGE_RESULT);
        canvas.dispatchEvent(new CustomEvent(BRIDGE_EVENT, {
            bubbles: true, detail: JSON.stringify({ type, options })
        }));
        const result = canvas.getAttribute(BRIDGE_RESULT);
        canvas.removeAttribute(BRIDGE_RESULT);
        if (result !== 'ok') throw new Error(result || 'Page blocked the Boid replay bridge.');
    }

    function dispatchRecordedEvent(target, entry, deferSpawn = false) {
        const options = {
            clientX: entry.x, clientY: entry.y, button: entry.button, buttons: entry.buttons,
            ...entry.modifiers, bubbles: true, cancelable: true
        };
        const canvas = document.getElementById('interactionCanvas');
        const pointerType = { mousedown: 'pointerdown', mousemove: 'pointermove', mouseup: 'pointerup' }[entry.type];
        if (target === canvas && pointerType) {
            dispatchCanvasCommand(canvas, pointerType, {
                ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true,
                pressure: entry.buttons ? 0.5 : 0, recorderDeferSpawn: deferSpawn
            });
        } else {
            target.dispatchEvent(new MouseEvent(entry.type, options));
        }
    }

    function getCanvasStroke(path) {
        const points = path.filter(entry => entry.target.selector === '#interactionCanvas'
            && entry.target.tagName === 'canvas' && ['mousemove', 'mousedown', 'mouseup'].includes(entry.type));
        const downs = points.filter(entry => entry.type === 'mousedown');
        const ups = points.filter(entry => entry.type === 'mouseup');
        if (downs.length !== 1 || ups.length !== 1 || ups[0].timestamp <= downs[0].timestamp) {
            throw new Error('Stroke timeline requires one canvas press and release per path.');
        }
        return { points, down: downs[0], up: ups[0], duration: ups[0].timestamp - downs[0].timestamp };
    }

    function createTimelineSettings(path, enabled = false) {
        let duration = 0;
        try { duration = getCanvasStroke(path).duration; } catch { /* invalid paths remain available in Click mode */ }
        return { enabled, trimStart: 0, trimEnd: duration, spawnAt: 0, stampAt: 0,
            position: 'path', x: 0, y: 0 };
    }

    function normalizeTimelineSettings(path, value, legacyEnabled = false) {
        const base = createTimelineSettings(path, legacyEnabled);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
        const duration = base.trimEnd;
        const finite = (candidate, fallback) => Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
        const trimStart = Math.max(0, Math.min(duration, finite(value.trimStart, 0)));
        const trimEnd = Math.max(trimStart, Math.min(duration, finite(value.trimEnd, duration)));
        const spawnAt = Math.max(trimStart, Math.min(trimEnd, finite(value.spawnAt, trimStart)));
        const stampAt = Math.max(spawnAt, Math.min(trimEnd, finite(value.stampAt, spawnAt)));
        return { enabled: typeof value.enabled === 'boolean' ? value.enabled : legacyEnabled,
            trimStart, trimEnd, spawnAt, stampAt,
            position: value.position === 'click' ? 'click' : 'path',
            x: Math.max(-1000, Math.min(1000, finite(value.x, 0))),
            y: Math.max(-1000, Math.min(1000, finite(value.y, 0))) };
    }

    function spawnPointAt(path, timestamp) {
        const points = getCanvasStroke(path).points;
        const next = points.findIndex(entry => entry.timestamp >= timestamp);
        if (next < 0) return points[points.length - 1];
        if (next === 0) return points[0];
        const before = points[next - 1], after = points[next];
        const fraction = (timestamp - before.timestamp) / (after.timestamp - before.timestamp || 1);
        return { x: before.x + (after.x - before.x) * fraction,
            y: before.y + (after.y - before.y) * fraction };
    }

    function buildTimelineSchedule(path, settings) {
        const { down, up, duration } = getCanvasStroke(path);
        const timeline = normalizeTimelineSettings(path, settings, true);
        if (timeline.trimEnd <= timeline.trimStart || duration <= 0) throw new Error('Timeline trim must retain part of the stroke.');
        const trimStartAt = down.timestamp + timeline.trimStart;
        const trimEndAt = down.timestamp + timeline.trimEnd;
        const startPoint = spawnPointAt(path, trimStartAt);
        const endPoint = spawnPointAt(path, trimEndAt);
        const spawnTimestamp = down.timestamp + timeline.spawnAt;
        const position = timeline.position === 'click' ? down : spawnPointAt(path, spawnTimestamp);
        const x = position.x + timeline.x, y = position.y + timeline.y;
        const schedule = path.filter(entry => entry !== down && entry !== up
            && entry.timestamp >= trimStartAt && entry.timestamp <= trimEndAt
            && !(entry.target.selector === '#interactionCanvas' && entry.type === 'click'))
            .map((entry, index) => ({ entry, at: entry.timestamp - trimStartAt, order: index + 3 }));
        schedule.push({ entry: { ...down, x: startPoint.x, y: startPoint.y }, at: 0, order: 0, kind: 'press' });
        schedule.push({ at: timeline.spawnAt - timeline.trimStart, order: 1, kind: 'spawn', x, y, deferStamp: true });
        const stampPoint = spawnPointAt(path, down.timestamp + timeline.stampAt);
        schedule.push({ at: timeline.stampAt - timeline.trimStart, order: 2, kind: 'stamp',
            x: stampPoint.x, y: stampPoint.y });
        schedule.push({ entry: { ...up, x: endPoint.x, y: endPoint.y },
            at: timeline.trimEnd - timeline.trimStart, order: path.length + 3 });
        return schedule.sort((first, second) => first.at - second.at || first.order - second.order);
    }

    function wait(delay) {
        return new Promise(resolve => {
            wakeTimer = resolve;
            timer = setTimeout(() => { timer = null; wakeTimer = null; resolve(); }, delay);
        });
    }

    function stopPlayback() {
        if (!playing) return;
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const wake = wakeTimer;
        wakeTimer = null;
        wake?.();
    }

    async function play() {
        if (recording || playing) return;
        let jobs;
        let repeats;
        try {
            const speed = Number(get('speed').value);
            repeats = Number(get('loopCount').value);
            if (!Number.isFinite(speed) || speed <= 0) throw new Error('Invalid playback speed.');
            if (!Number.isInteger(repeats) || repeats < 0) throw new Error('Invalid repeat count.');
            if (sequenceSteps.length) {
                const saved = readSaved();
                jobs = sequenceSteps.map((step, index) => {
                    if (step.kind !== 'path') throw new Error(`Unsupported step at position ${index + 1}.`);
                    if (!Object.hasOwn(saved, step.name)) throw new Error(`Step ${index + 1}: select a saved path.`);
                    const { path, timeline } = unpackSavedPath(saved[step.name]);
                    if (!path.length) throw new Error(`Step ${index + 1}: path is empty.`);
                    if (!Number.isFinite(step.speed) || step.speed <= 0) throw new Error(`Step ${index + 1}: invalid speed.`);
                    return { path, timeline, speed: speed * step.speed, name: step.name };
                });
            } else {
                validatePath(mousePath);
                if (!mousePath.length) throw new Error('No events to play.');
                jobs = [{ path: mousePath, timeline: normalizeTimelineSettings(mousePath, timelineSettings),
                    speed, name: 'Current path' }];
            }
            if (jobs.some(job => job.timeline.enabled)) {
                const canvas = document.getElementById('interactionCanvas');
                if (!canvas) throw new Error('Boid canvas not found.');
            }
            jobs = jobs.map(job => ({ ...job, schedule: job.timeline.enabled
                ? buildTimelineSchedule(job.path, job.timeline)
                : job.path.map((entry, index) => ({
                    entry, at: entry.timestamp, order: index
                })) }));
        } catch (error) { message(error.message, true); return; }
        playing = true;
        cancelled = false;
        updateControls();
        let result = 'Playback complete.';
        let failed = false;
        let pressedCanvas = null;
        let lastEntry = null;
        try {
            for (let cycle = 0; !cancelled && (repeats === 0 || cycle < repeats); cycle++) {
                for (const [stepIndex, job] of jobs.entries()) {
                    if (cancelled) break;
                    const row = get('sequenceList').children[stepIndex];
                    row?.classList.add('running');
                    message(`Playing ${job.name} (${cycle + 1}${repeats ? `/${repeats}` : ''})`);
                    const started = performance.now();
                    try {
                        if (job.timeline.enabled) {
                            dispatchCanvasCommand(document.getElementById('interactionCanvas'), 'check', {});
                            directPlaybackActive = true;
                        }
                        for (const [index, item] of job.schedule.entries()) {
                            if (cancelled) break;
                            await wait(Math.max(0, started + item.at / job.speed - performance.now()));
                            if (cancelled) break;
                            if (item.kind === 'spawn') {
                                dispatchCanvasCommand(document.getElementById('interactionCanvas'), 'spawn', {
                                    clientX: item.x, clientY: item.y, deferStamp: item.deferStamp === true
                                });
                                continue;
                            }
                            if (item.kind === 'stamp') {
                                dispatchCanvasCommand(document.getElementById('interactionCanvas'), 'stamp', {
                                    clientX: item.x, clientY: item.y
                                });
                                continue;
                            }
                            const entry = item.entry;
                            const target = resolveTarget(entry.target);
                            if (!target) throw new Error(`Step ${stepIndex + 1}, event ${index + 1}: target not found (${entry.target.selector}).`);
                            showIndicator(entry.x, entry.y);
                            dispatchRecordedEvent(target, entry, item.kind === 'press');
                            lastEntry = entry;
                            if (target.id === 'interactionCanvas') {
                                if (entry.type === 'mousedown') pressedCanvas = target;
                                if (entry.type === 'mouseup') pressedCanvas = null;
                            }
                        }
                        if (pressedCanvas && !cancelled && lastEntry) {
                            dispatchRecordedEvent(pressedCanvas, { ...lastEntry, type: 'mouseup', button: 0, buttons: 0 });
                            pressedCanvas = null;
                        }
                    } finally {
                        if (directPlaybackActive) {
                            const canvasToRelease = pressedCanvas?.isConnected ? pressedCanvas : null;
                            pressedCanvas = null;
                            try {
                                if (canvasToRelease && lastEntry) {
                                    dispatchRecordedEvent(canvasToRelease,
                                        { ...lastEntry, type: 'mouseup', button: 0, buttons: 0 });
                                }
                            } finally {
                                dispatchCanvasCommand(document.getElementById('interactionCanvas'), 'end', {});
                                directPlaybackActive = false;
                            }
                        }
                        row?.classList.remove('running');
                    }
                }
            }
            if (cancelled) result = 'Playback stopped.';
        } catch (error) {
            result = `Playback failed: ${error.message}`;
            failed = true;
        } finally {
            if (pressedCanvas?.isConnected && lastEntry) {
                try { dispatchRecordedEvent(pressedCanvas, { ...lastEntry, type: 'mouseup', button: 0, buttons: 0 }); }
                catch (error) { result = `Playback release failed: ${error.message}`; failed = true; }
            }
            if (directPlaybackActive) {
                try { dispatchCanvasCommand(document.getElementById('interactionCanvas'), 'end', {}); }
                catch (error) { result = `Playback cleanup failed: ${error.message}`; failed = true; }
                directPlaybackActive = false;
            }
            indicator.style.display = 'none';
            playing = false;
            timer = null;
            wakeTimer = null;
            updateControls();
            message(result, failed);
        }
    }

    function readSaved() {
        const saved = GM_getValue(STORAGE_KEY, {});
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved path index is malformed.');
        return Object.assign(Object.create(null), saved);
    }

    function unpackSavedPath(value) {
        if (Array.isArray(value)) {
            const path = validatePath(value);
            return { path, timeline: normalizeTimelineSettings(path, null, true) };
        }
        if (!value || typeof value !== 'object' || value.version !== SAVED_PATH_VERSION) {
            throw new Error('Saved path entry is malformed.');
        }
        const path = validatePath(value.path);
        return { path, timeline: normalizeTimelineSettings(path, value.timeline, false) };
    }

    function renderSequence(saved = readSaved()) {
        const list = get('sequenceList');
        list.replaceChildren();
        sequenceSteps.forEach((step, index) => {
            const row = document.createElement('div');
            row.className = 'sequence-step';
            row.setAttribute('role', 'listitem');
            const path = document.createElement('select');
            path.setAttribute('aria-label', `Step ${index + 1} path`);
            path.add(new Option('Select path', ''));
            for (const name of Object.keys(saved).sort()) path.add(new Option(name, name));
            path.value = Object.hasOwn(saved, step.name) ? step.name : '';
            path.addEventListener('change', () => { step.name = path.value; });
            const speed = document.createElement('select');
            speed.setAttribute('aria-label', `Step ${index + 1} speed`);
            for (const value of [0.25, 0.5, 1, 2, 4]) speed.add(new Option(`${value}x`, String(value)));
            speed.value = String(step.speed);
            speed.addEventListener('change', () => { step.speed = Number(speed.value); });
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '\u00d7';
            remove.title = `Remove step ${index + 1}`;
            remove.setAttribute('aria-label', remove.title);
            remove.addEventListener('click', () => {
                sequenceSteps.splice(index, 1);
                renderSequence(saved);
                updateControls();
            });
            row.append(path, speed, remove);
            list.append(row);
        });
        updateControls();
    }

    function addStep() {
        if (recording || playing) return;
        try {
            const saved = readSaved();
            const name = get('saved').value || Object.keys(saved).sort()[0];
            if (!name) throw new Error('Save a path before adding a step.');
            sequenceSteps.push({ kind: 'path', name, speed: 1 });
            renderSequence(saved);
        } catch (error) { message(`Add step failed: ${error.message}`, true); }
    }

    function refreshSaved() {
        const saved = readSaved();
        const select = get('saved');
        const chosen = select.value;
        select.replaceChildren(new Option('Saved paths', ''));
        for (const name of Object.keys(saved).sort()) select.add(new Option(name, name));
        select.value = Object.hasOwn(saved, chosen) ? chosen : '';
        renderSequence(saved);
    }

    function save() {
        if (playing || recording) return;
        try {
            validatePath(mousePath);
            if (!mousePath.length) throw new Error('No events to save.');
            const name = get('name').value.trim();
            if (!name) throw new Error('Enter a path name.');
            const saved = readSaved();
            if (Object.hasOwn(saved, name) && !confirm(`Replace saved path "${name}"?`)) return;
            saved[name] = { version: SAVED_PATH_VERSION,
                path: mousePath.map(entry => ({ ...entry, modifiers: { ...entry.modifiers }, target: { ...entry.target } })),
                timeline: { ...normalizeTimelineSettings(mousePath, timelineSettings) } };
            GM_setValue(STORAGE_KEY, saved);
            refreshSaved();
            get('saved').value = name;
            message(`Saved "${name}".`);
        } catch (error) { message(`Save failed: ${error.message}`, true); }
    }

    function load() {
        if (playing || recording) return;
        try {
            const name = get('saved').value;
            if (!name) throw new Error('Choose a saved path.');
            const saved = readSaved();
            if (!Object.hasOwn(saved, name)) throw new Error('Saved path is missing.');
            const { path, timeline } = unpackSavedPath(saved[name]);
            mousePath.length = 0;
            for (const entry of path) mousePath.push(entry);
            timelineSettings = { ...timeline };
            get('name').value = name;
            updateControls();
            message(`Loaded "${name}" (${mousePath.length} events).`);
        } catch (error) { message(`Load failed: ${error.message}`, true); }
    }

    function exportPath() {
        if (playing || recording) return;
        try {
            validatePath(mousePath);
            if (!mousePath.length) throw new Error('No events to export.');
            const url = URL.createObjectURL(new Blob([JSON.stringify({ version: SAVED_PATH_VERSION,
                mousePath, timeline: normalizeTimelineSettings(mousePath, timelineSettings) }, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'mouse-path.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            message('Path exported.');
        } catch (error) { message(`Export failed: ${error.message}`, true); }
    }

    async function importPath(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || playing || recording) return;
        try {
            const data = JSON.parse(await file.text());
            if (!data || ![1, SAVED_PATH_VERSION].includes(data.version)) throw new Error('Unsupported path format.');
            const path = validatePath(data.mousePath);
            if (playing || recording) throw new Error('Stop recording or playback before importing.');
            mousePath.length = 0;
            for (const entry of path) mousePath.push(entry);
            timelineSettings = normalizeTimelineSettings(path,
                data.version === SAVED_PATH_VERSION ? data.timeline : null, data.version === 1);
            updateControls();
            message(`Imported ${mousePath.length} events.`);
        } catch (error) { message(`Import failed: ${error.message}`, true); }
    }

    function clear() {
        if (playing || recording || !confirm('Clear the current mouse path? Saved paths will remain.')) return;
        mousePath.length = 0;
        timelineSettings = createTimelineSettings([], false);
        updateControls();
        message('Current path cleared.');
    }

    function bindTimelineHandle(handle) {
        const field = handle.dataset.field;
        const valueFromClientX = clientX => {
            const rect = get('timelineGraph').getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            return fraction * timelineDuration();
        };
        handle.addEventListener('pointerdown', event => {
            if (handle.disabled) return;
            event.preventDefault();
            handle.setPointerCapture(event.pointerId);
            let pendingValue = valueFromClientX(event.clientX);
            const preview = moveEvent => {
                pendingValue = valueFromClientX(moveEvent.clientX);
                handle.style.left = `${timelineDuration() ? pendingValue / timelineDuration() * 100 : 0}%`;
            };
            const finish = async upEvent => {
                handle.removeEventListener('pointermove', preview);
                handle.removeEventListener('pointerup', finish);
                handle.removeEventListener('pointercancel', cancel);
                if (handle.hasPointerCapture(upEvent.pointerId)) handle.releasePointerCapture(upEvent.pointerId);
                const inputValue = field === 'spawnAt' || field === 'stampAt'
                    ? pendingValue - timelineSettings.trimStart : pendingValue;
                await setTimelineField(field, inputValue);
            };
            const cancel = eventToCancel => {
                handle.removeEventListener('pointermove', preview);
                handle.removeEventListener('pointerup', finish);
                handle.removeEventListener('pointercancel', cancel);
                if (handle.hasPointerCapture(eventToCancel.pointerId)) handle.releasePointerCapture(eventToCancel.pointerId);
                renderTimeline();
            };
            handle.addEventListener('pointermove', preview);
            handle.addEventListener('pointerup', finish);
            handle.addEventListener('pointercancel', cancel);
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const current = timelineSettings[field];
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? timelineDuration()
                : current + (event.key === 'ArrowLeft' ? -step : step);
            setTimelineField(field, field === 'spawnAt' || field === 'stampAt'
                ? next - timelineSettings.trimStart : next);
        });
    }

    function cleanup() {
        stopPlayback();
        recording = false;
        if (directPlaybackActive) {
            try { dispatchCanvasCommand(document.getElementById('interactionCanvas'), 'end', {}); } catch { /* page is closing */ }
            directPlaybackActive = false;
        }
        document.dispatchEvent(new Event(BRIDGE_CLEANUP_EVENT));
        for (const type of [...EVENT_TYPES, ...Object.keys(POINTER_TYPES)]) document.removeEventListener(type, onMouse, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('pagehide', cleanup);
        root.remove();
        indicator.remove();
        if (globalThis[CLEANUP_KEY] === cleanup) delete globalThis[CLEANUP_KEY];
    }

    for (const type of [...EVENT_TYPES, ...Object.keys(POINTER_TYPES)]) document.addEventListener(type, onMouse, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', cleanup);
    get('record').addEventListener('click', toggleRecording);
    get('stop').addEventListener('click', () => recording ? stopRecording() : stopPlayback());
    get('play').addEventListener('click', play);
    get('compactRecord').addEventListener('click', toggleRecording);
    get('compactStop').addEventListener('click', () => recording ? stopRecording() : stopPlayback());
    get('compactPlay').addEventListener('click', play);
    get('compactSave').addEventListener('click', saveFromCompactControls);
    get('minimizeButton').addEventListener('click', () => setRecorderMinimized(!recorderMinimized));
    get('timelineButton').addEventListener('click', () => {
        timelineDrawerOpen = !timelineDrawerOpen;
        renderTimeline();
    });
    get('timelineEnabled').addEventListener('change', event => {
        timelineSettings.enabled = event.target.checked;
        renderTimeline();
    });
    for (const id of ['trimStart', 'trimEnd', 'spawnAt', 'stampAt']) {
        get(id).addEventListener('change', event => setTimelineField(id, Number(event.target.value)));
    }
    for (const handle of get('timelineGraph').querySelectorAll('.timeline-handle')) bindTimelineHandle(handle);
    get('spawnPosition').addEventListener('change', event => {
        timelineSettings.position = event.target.value === 'click' ? 'click' : 'path';
        renderTimeline();
    });
    for (const [id, field] of [['spawnX', 'x'], ['spawnY', 'y']]) {
        get(id).addEventListener('change', event => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) timelineSettings[field] = Math.max(-1000, Math.min(1000, value));
            renderTimeline();
        });
    }
    get('addStep').addEventListener('click', addStep);
    get('save').addEventListener('click', save);
    get('load').addEventListener('click', load);
    get('export').addEventListener('click', exportPath);
    get('import').addEventListener('click', () => get('file').click());
    get('file').addEventListener('change', importPath);
    get('clear').addEventListener('click', clear);
    globalThis[CLEANUP_KEY] = cleanup;
    updateControls();
    try { refreshSaved(); } catch (error) { message(`Storage unavailable: ${error.message}`, true); }
})();