'use strict';
const $ = (id) => document.getElementById(id);
const api = window.clfed;
let lang = 'ar';
let state = {};
let selected = null;
let clips = [];
let monitorData = { list: [], selected: '' };
let aboutData = null;
let toastTimer;
let captureMode = 'screen';
let audioMode = 'separate';
let windowChoice = '';
let hotkeys = {};
let listening = null;

// Fine steps at the short end, coarser ones up to 30 minutes.
function buildStops(first) {
  const stops = [];
  for (let s = first; s <= 60; s += 1) stops.push(s);
  for (let s = 65; s <= 300; s += 5) stops.push(s);
  for (let s = 310; s <= 600; s += 10) stops.push(s);
  for (let s = 630; s <= 1800; s += 30) stops.push(s);
  return stops;
}
const RECORD_STOPS = buildStops(1);
const REPLAY_STOPS = buildStops(5);

const t = (key) => I18N[lang][key] || key;
const ltr = (text) => `⁦${text}⁩`;
const size = (bytes) => ltr(bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const date = (ms) => new Date(ms).toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
function duration(seconds) {
  if (seconds < 60) return `${ltr(seconds)} ${t('sec')}`;
  return `${ltr(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)} ${t('min')}`;
}

function toast(text, tone = 'info') {
  const box = $('toast');
  box.textContent = text;
  box.className = tone;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
}
const guard = async (work) => {
  try { return await work(); } catch (error) {
    toast(t(String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), 'warn');
    return undefined;
  }
};

function nearest(stops, value) {
  let best = 0;
  stops.forEach((stop, index) => { if (Math.abs(stop - value) < Math.abs(stops[best] - value)) best = index; });
  return best;
}

function setupMeter(prefix, stops, update) {
  const slider = $(`${prefix}Slider`);
  slider.max = stops.length - 1;
  const commit = () => update(stops[Number(slider.value)], true);
  slider.addEventListener('input', () => update(stops[Number(slider.value)], false));
  slider.addEventListener('change', commit);
  const stepper = (button, delta) => {
    let timer = null;
    let delay = null;
    const step = () => { slider.value = Number(slider.value) + delta; update(stops[Number(slider.value)], false); };
    const end = () => { if (delay === null) return; clearTimeout(delay); clearInterval(timer); delay = null; commit(); };
    button.addEventListener('pointerdown', () => { step(); delay = setTimeout(() => { timer = setInterval(step, 70); }, 350); });
    button.addEventListener('pointerup', end);
    button.addEventListener('pointerleave', end);
  };
  stepper($(`${prefix}Down`), -1);
  stepper($(`${prefix}Up`), 1);
}

function renderRecordValue() {
  const off = $('recordUnlimited').checked;
  $('recordSlider').disabled = off;
  $('recordDown').disabled = off;
  $('recordUp').disabled = off;
  $('recordValue').textContent = off ? t('noLimit') : duration(RECORD_STOPS[Number($('recordSlider').value)]);
}
function renderReplayValue() {
  const value = duration(REPLAY_STOPS[Number($('replaySlider').value)]);
  $('replayValue').textContent = value;
  $('replayLength').textContent = `${t('last')} ${value}`;
}
function saveTiming() {
  return guard(() => api.saveTiming({
    recordSeconds: $('recordUnlimited').checked ? 0 : RECORD_STOPS[Number($('recordSlider').value)],
    lastRecordSeconds: RECORD_STOPS[Number($('recordSlider').value)],
    replaySeconds: REPLAY_STOPS[Number($('replaySlider').value)],
  }));
}
setupMeter('record', RECORD_STOPS, (_value, final) => { renderRecordValue(); if (final) saveTiming(); });
setupMeter('replay', REPLAY_STOPS, (_value, final) => { renderReplayValue(); if (final) saveTiming(); });
$('recordUnlimited').addEventListener('change', () => { renderRecordValue(); saveTiming(); });

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab,.page').forEach((node) => node.classList.remove('active'));
  tab.classList.add('active');
  $(tab.dataset.page).classList.add('active');
}));
$('installUpdate').addEventListener('click', () => guard(() => api.action('installUpdate')));
for (const id of ['saveReplay', 'toggleRecord', 'screenshot', 'toggleReplay']) {
  $(id).addEventListener('click', () => guard(() => api.action(id)));
}
$('startAt').addEventListener('change', () => {
  $('clearSchedule').hidden = !$('startAt').value;
  guard(() => api.action('schedule', $('startAt').value));
  if ($('startAt').value) toast(`${t('scheduled')} ${ltr($('startAt').value)} ${t('whileOpen')}`, 'good');
});
$('clearSchedule').addEventListener('click', () => { $('startAt').value = ''; $('clearSchedule').hidden = true; guard(() => api.action('schedule', '')); });

function renderUpdate() {
  const update = state.update;
  $('updateBar').hidden = !update;
  if (!update) return;
  const text = { available: `${t('updateAvailable')} ${ltr(update.version)}`, downloading: `${t('updateDownloading')} ${ltr(`${update.progress}%`)}`, installing: t('updateInstalling') };
  $('updateText').textContent = text[update.phase];
  $('installUpdate').hidden = update.phase !== 'available';
}
function renderState(next) {
  state = next;
  renderUpdate();
  $('saveReplay').disabled = !state.replay;
  $('dot').className = state.record ? 'rec' : state.replay ? 'on' : '';
  $('statusText').textContent = state.waiting && !state.record && !state.replay ? t('waitingGame') : state.record ? `${t('recording')} ${ltr(state.timecode || '')}` : state.replay ? t('replayRunning') : t('ready');
  const left = state.stopAt ? Math.max(0, Math.ceil((state.stopAt - Date.now()) / 1000)) : 0;
  let label = t('startRecord');
  if (state.record) label = left ? `${t('stopRecord')}، ${t('remaining')} ${duration(left)}` : `${t('stopRecord')} ${ltr(state.timecode || '')}`;
  $('recordLabel').textContent = lang === 'en' ? label.replace('،', ',') : label;
  $('toggleRecord').classList.toggle('active', Boolean(state.record));
  $('replayState').textContent = state.replay ? 'ON' : 'OFF';
  $('toggleReplay').setAttribute('aria-checked', String(Boolean(state.replay)));
  if (state.autoReplay !== undefined) $('autoReplay').checked = state.autoReplay;
  $('toggleReplay').classList.toggle('active', Boolean(state.replay));
}

function thumb(clip) {
  if (clip.image) { const img = new Image(); img.src = clip.url; img.alt = ''; img.className = 'thumb'; return img; }
  const video = document.createElement('video');
  video.src = `${clip.url}#t=1`; video.preload = 'metadata'; video.muted = true; video.className = 'thumb';
  return video;
}
const emptyNote = (key) => Object.assign(document.createElement('p'), { className: 'empty', textContent: t(key) });

function openClip(clip) {
  selected = clip;
  document.querySelector('[data-page=clips]').click();
  renderList();
  renderViewer();
}
function renderViewer() {
  const viewer = $('viewer');
  const clip = selected;
  if (!clip) { viewer.replaceChildren(emptyNote('pickClip')); return; }
  let media;
  if (clip.image) { media = new Image(); media.alt = clip.name; } else { media = document.createElement('video'); media.controls = true; }
  media.src = clip.url;
  media.onerror = () => toast(t('viewerFail'), 'warn');
  const trim = clip.image ? null : buildTrim(media, clip);
  const tools = document.createElement('div');
  tools.className = 'tools';
  const button = (key, work) => { const b = document.createElement('button'); b.textContent = t(key); b.onclick = () => guard(work); tools.append(b); };
  const rename = document.createElement('input');
  rename.placeholder = t('newName');
  const closeAfter = async (name, value) => { await api.clip(name, clip.file, value); selected = null; renderViewer(); await refreshClips(); };
  button('openExternal', () => api.clip('open', clip.file));
  button('reveal', () => api.clip('reveal', clip.file));
  button('trash', () => closeAfter('trash'));
  tools.append(rename);
  button('rename', () => closeAfter('rename', rename.value));
  viewer.replaceChildren(...[media, trim, tools].filter(Boolean));
}

function buildTrim(video, clip) {
  const box = document.createElement('div');
  box.className = 'trim';
  box.hidden = true;
  const row = (key) => {
    const line = document.createElement('div'); line.className = 'trimRow';
    const label = document.createElement('span'); label.textContent = t(key);
    const input = Object.assign(document.createElement('input'), { type: 'range', min: 0, step: 0.1, dir: 'ltr' });
    const out = document.createElement('output');
    line.append(label, input, out); box.append(line);
    return { input, out };
  };
  const start = row('trimStart');
  const end = row('trimEnd');
  const tools = document.createElement('div'); tools.className = 'trimTools';
  const total = document.createElement('b');
  const seconds = (value) => `${ltr(Number(value).toFixed(1))} ${t('sec')}`;
  const paint = () => {
    start.out.textContent = seconds(start.input.value);
    end.out.textContent = seconds(end.input.value);
    total.textContent = `${t('length')}: ${seconds(Math.max(0, end.input.value - start.input.value))}`;
  };
  const add = (key, work) => { const b = document.createElement('button'); b.textContent = t(key); b.onclick = work; tools.append(b); return b; };
  add('setStart', () => { start.input.value = Math.min(video.currentTime, Number(end.input.value) - 0.1); paint(); });
  add('setEnd', () => { end.input.value = Math.max(video.currentTime, Number(start.input.value) + 0.1); paint(); });
  const save = add('trimSave', async () => {
    save.disabled = true;
    toast(t('trimming'));
    const done = await guard(async () => { await api.clip('trim', clip.file, { start: Number(start.input.value), end: Number(end.input.value) }); return true; });
    save.disabled = false;
    if (done) { toast(t('trimDone'), 'good'); refreshClips(); }
  });
  tools.append(total); box.append(tools);
  start.input.addEventListener('input', () => {
    if (Number(start.input.value) > Number(end.input.value) - 0.1) start.input.value = Number(end.input.value) - 0.1;
    video.currentTime = Number(start.input.value); paint();
  });
  end.input.addEventListener('input', () => {
    if (Number(end.input.value) < Number(start.input.value) + 0.1) end.input.value = Number(start.input.value) + 0.1;
    video.currentTime = Number(end.input.value); paint();
  });
  video.addEventListener('timeupdate', () => { if (!video.paused && video.currentTime >= Number(end.input.value)) video.pause(); });
  video.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(video.duration)) return;
    start.input.max = video.duration; end.input.max = video.duration; end.input.value = video.duration;
    box.hidden = false; paint();
  });
  return box;
}

function renderList() {
  const list = $('clipList');
  if (!clips.length) { list.replaceChildren(emptyNote('noClips')); return; }
  list.replaceChildren(...clips.map((clip) => {
    const row = document.createElement('button');
    row.className = `row${selected && clip.file === selected.file ? ' active' : ''}`;
    const name = document.createElement('b'); name.textContent = clip.name; name.dir = 'ltr';
    const info = document.createElement('small'); info.textContent = `${size(clip.size)} · ${date(clip.time)}`;
    row.append(name, info);
    row.onclick = () => openClip(clip);
    return row;
  }));
}

let lastData = null;
function renderSummary() {
  if (!lastData) return;
  $('clipCount').textContent = clips.length || '';
  $('clipSummary').textContent = `${clips.length} ${t('files')}, ${size(lastData.total)}, ${t('inFolder')} ${ltr(lastData.folder)}`;
}
async function refreshClips() {
  const data = await guard(() => api.clips());
  if (!data) return;
  lastData = data;
  clips = data.clips;
  renderSummary();
  renderList();
  const recent = clips.slice(0, 3).map((clip) => {
    const item = document.createElement('button');
    const label = document.createElement('span'); label.textContent = clip.name; label.dir = 'ltr';
    item.append(thumb(clip), label);
    item.onclick = () => openClip(clip);
    return item;
  });
  $('recent').replaceChildren(...(recent.length ? recent : [emptyNote('firstClip')]));
}

function renderMonitors() {
  const current = $('monitor').value || monitorData.selected;
  $('monitor').replaceChildren(...monitorData.list.map((m, index) => new Option(
    `${t('screen')} ${index + 1}: ${m.width}×${m.height}${m.primary ? ` (${t('primary')})` : ''}`, m.value, false, m.value === current)));
}

function applyLanguage() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-t]').forEach((node) => { node.textContent = t(node.dataset.t); });
  renderHotkeys();
  document.querySelectorAll('[data-title]').forEach((node) => { node.title = t(node.dataset.title); node.setAttribute('aria-label', t(node.dataset.title)); });
  document.querySelectorAll('[data-lang]').forEach((node) => node.classList.toggle('active', node.dataset.lang === lang));
  if (aboutData) $('about').textContent = `CLFED Capture ${aboutData.version}\n${t('madeBy')} ${aboutData.author}`;
  renderRecordValue();
  renderReplayValue();
  renderState(state);
  renderMonitors();
  renderSummary();
  renderList();
  renderViewer();
  if (!clips.length) $('recent').replaceChildren(emptyNote('firstClip'));
}
document.querySelectorAll('[data-lang]').forEach((button) => button.addEventListener('click', () => {
  lang = button.dataset.lang;
  applyLanguage();
  guard(() => api.setLanguage(lang));
}));

$('pickFolder').addEventListener('click', async () => {
  const folder = await guard(() => api.pickFolder());
  if (folder) $('clipsFolder').value = folder;
});
function collectSettings() {
  return {
    captureMode, monitorValue: $('monitor').value, windowName: $('windowName').value || windowChoice, fps: Number($('fps').value), resolution: $('resolution').value,
    showRecordTimer: $('showRecordTimer').checked, autoReplay: $('autoReplay').checked, onlyGaming: $('onlyGaming').checked, customGames: $('customGames').value,
    storageLimitGB: Math.max(0, Number($('storageLimitGB').value) || 0), clipsFolder: $('clipsFolder').value,
  };
}
document.querySelectorAll('.settings-form').forEach((form) => form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('.primary');
  button.disabled = true;
  const ok = await guard(() => api.apply(collectSettings()));
  button.disabled = false;
  if (ok) { toast(t('saved'), 'good'); refreshClips(); }
}));

function renderCaptureMode() {
  document.querySelectorAll('[data-mode]').forEach((node) => node.classList.toggle('active', node.dataset.mode === captureMode));
  $('windowRow').hidden = captureMode !== 'window';
  $('monitorRow').hidden = captureMode === 'window';
  $('gamingRow').hidden = captureMode === 'games';
}
async function refreshWindows() {
  const names = (await guard(() => api.windows())) || [];
  if (windowChoice && !names.includes(windowChoice)) names.unshift(windowChoice);
  $('windowName').replaceChildren(new Option(t('noWindow'), ''), ...names.map((name) => new Option(name, name, false, name === windowChoice)));
}
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  captureMode = button.dataset.mode;
  renderCaptureMode();
  if (captureMode === 'window') refreshWindows();
}));
$('refreshWindows').addEventListener('click', refreshWindows);
$('windowName').addEventListener('change', () => { windowChoice = $('windowName').value; });

function renderAudioMode() {
  document.querySelectorAll('[data-audio]').forEach((node) => node.classList.toggle('active', node.dataset.audio === audioMode));
  $('systemGroup').hidden = audioMode !== 'together';
  $('discordGroup').hidden = audioMode !== 'separate';
  $('appsGroup').hidden = audioMode !== 'separate';
}
const applyAudio = async () => { if (await guard(() => api.apply({ audioMode, systemOn: $('systemOn').checked, mic: $('mic').checked, micDevice: $('micDevice').value }))) toast(t('saved'), 'good'); };
document.querySelectorAll('[data-audio]').forEach((button) => button.addEventListener('click', () => {
  audioMode = button.dataset.audio;
  renderAudioMode();
  applyAudio();
}));
for (const id of ['systemOn', 'mic', 'micDevice']) $(id).addEventListener('change', applyAudio);
document.querySelectorAll('[data-volume]').forEach((slider) => {
  const out = slider.nextElementSibling;
  slider.addEventListener('input', () => { out.textContent = `${slider.value}%`; guard(() => api.setVolume(slider.dataset.volume, Number(slider.value))); });
});
async function loadMics(selected) {
  const mics = (await guard(() => api.mics())) || [];
  $('micDevice').replaceChildren(new Option(t('micDefault'), ''), ...mics.map((mic) => new Option(mic.label, mic.id, false, mic.id === selected)));
}

const showAudioOffset = () => { $('audioOffsetValue').textContent = `${$('audioOffset').value} ms`; };
$('audioOffset').addEventListener('input', showAudioOffset);
$('audioOffset').addEventListener('change', () => guard(() => api.setAudioOffset(Number($('audioOffset').value))));
$('openAtLogin').addEventListener('change', async () => {
  const value = await guard(() => api.setStartup($('openAtLogin').checked));
  if (value === undefined) $('openAtLogin').checked = !$('openAtLogin').checked;
});

const prettyKey = (key) => String(key || '').replace(/\+/g, ' + ');
function renderHotkeys() {
  $('kbdSave').textContent = prettyKey(hotkeys.saveReplay);
  $('kbdRecord').textContent = prettyKey(hotkeys.toggleRecord);
  $('kbdShot').textContent = prettyKey(hotkeys.screenshot);
  document.querySelectorAll('[data-hotkey]').forEach((button) => {
    const active = listening === button.dataset.hotkey;
    button.textContent = active ? t('hotkeyPress') : prettyKey(hotkeys[button.dataset.hotkey]);
    button.classList.toggle('listening', active);
  });
}
function keyName(event) {
  const { code } = event;
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /\d$/.test(code)) return `num${code.slice(6)}`;
  return { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Tab: 'Tab', Space: 'Space', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[code] || '';
}
document.querySelectorAll('[data-hotkey]').forEach((button) => button.addEventListener('click', () => {
  listening = listening === button.dataset.hotkey ? null : button.dataset.hotkey;
  renderHotkeys();
}));
window.addEventListener('keydown', async (event) => {
  if (!listening) return;
  event.preventDefault();
  if (event.code === 'Escape') { listening = null; renderHotkeys(); return; }
  const key = keyName(event);
  if (!key) return;
  const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
  const name = listening;
  listening = null;
  const next = await guard(() => api.setHotkey(name, [...modifiers, key].join('+')));
  if (next) { hotkeys = next; toast(t('saved'), 'good'); }
  renderHotkeys();
});
$('resetHotkeys').addEventListener('click', async () => {
  const next = await guard(() => api.resetHotkeys());
  if (next) { hotkeys = next; renderHotkeys(); toast(t('saved'), 'good'); }
});

api.on('state', renderState);
api.on('toast', (data) => toast(data.key ? (data.detail ? `${t(data.key)}: ${data.detail}` : t(data.key)) : data.text, data.tone));
api.on('clips-changed', refreshClips);
api.on('schedule-done', () => { $('startAt').value = ''; $('clearSchedule').hidden = true; });

(async () => {
  const data = await api.init();
  const s = data.settings;
  lang = s.language;
  aboutData = data;
  monitorData = { list: data.monitors, selected: s.monitorValue };
  $('author').textContent = data.author;
  $('recordSlider').value = nearest(RECORD_STOPS, s.lastRecordSeconds);
  $('recordUnlimited').checked = s.recordSeconds === 0;
  $('replaySlider').value = nearest(REPLAY_STOPS, s.replaySeconds);
  $('fps').value = String(s.fps);
  $('resolution').value = String(s.resolution);
  $('storageLimitGB').value = s.storageLimitGB;
  $('clipsFolder').value = s.clipsFolder;
  $('autoReplay').checked = s.autoReplay;
  $('onlyGaming').checked = s.onlyGaming;
  $('audioOffset').value = s.audioSyncMs;
  showAudioOffset();
  $('showRecordTimer').checked = s.showRecordTimer;
  $('customGames').value = s.customGames;
  $('systemOn').checked = s.systemOn;
  captureMode = s.captureMode;
  audioMode = s.audioMode;
  windowChoice = s.windowName;
  hotkeys = s.hotkeys;
  document.querySelectorAll('[data-volume]').forEach((slider) => {
    slider.value = s[`${slider.dataset.volume}Volume`];
    slider.nextElementSibling.textContent = `${slider.value}%`;
  });
  $('mic').checked = s.mic;
  $('openAtLogin').checked = s.openAtLogin;
  if (data.state.startAt) { $('startAt').value = data.state.startAt; $('clearSchedule').hidden = false; }
  state = data.state;
  applyLanguage();
  renderCaptureMode();
  renderAudioMode();
  if (captureMode === 'window') refreshWindows();
  await refreshClips();
  await loadMics(s.micDevice);
})();
