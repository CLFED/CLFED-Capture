'use strict';
const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, screen, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const I18N = require('./ui/i18n');

const CLIP_EXT = new Set(['.mp4', '.webm', '.png']);
const RESOLUTIONS = { 720: [1280, 720], 1080: [1920, 1080], '2k': [2048, 1080], 1440: [2560, 1440] };
const BITS_PER_PIXEL = 0.3;
const SEGMENT_SECONDS = 5;
const PCM_BATCH_BYTES = 7680;
const GPU_START_MS = 8000;
const GPU_RETRY = 'gpu-retry';
const PCM_BYTES_PER_SECOND = 192000;
const AUDIO_BUCKET_BYTES = PCM_BYTES_PER_SECOND * 10;
const AUDIO_RESYNC_BYTES = 9600;
const testMode = !app.isPackaged && Boolean(process.env.CLFED_TEST_HOME);
const UPDATE_PREFIX = 'https://github.com/CLFED/CLFED-Capture/releases/download/';
const UPDATE_URL = (testMode && process.env.CLFED_UPDATE_URL) || 'https://github.com/CLFED/CLFED-Capture/releases/latest/download/latest.json';
const GPU_BITS_PER_PIXEL = 0.18;
const GPU_MAX_BITRATE = 90000000;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const OVERLAY_SIZE = { width: 300, height: 76 };
const TIMER_SIZE = { width: 130, height: 42 };
const DEFAULT_HOTKEYS = { saveReplay: 'Alt+F8', toggleRecord: 'Alt+F7', screenshot: 'Alt+F6' };
const DISCORD_EXES = ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe'];
const KNOWN_GAMES = ['VALORANT-Win64-Shipping.exe', 'cs2.exe', 'FortniteClient-Win64-Shipping.exe', 'RobloxPlayerBeta.exe', 'GTA5.exe', 'GTA5_Enhanced.exe',
  'cod.exe', 'r5apex.exe', 'Overwatch.exe', 'RocketLeague.exe', 'League of Legends.exe', 'Marvel-Win64-Shipping.exe', 'RainbowSix.exe', 'EscapeFromTarkov.exe', 'Minecraft.Windows.exe', 'javaw.exe', 'eldenring.exe', 'FC26.exe', 'Cyberpunk2077.exe'];
if (!app.isPackaged && process.env.CLFED_TEST_HOME) app.setPath('userData', process.env.CLFED_TEST_HOME);

let win = null;
let captureWin = null;
let tray = null;
let settings = null;
let quitting = false;
let nextCommand = 1;
const pendingCommands = new Map();
let state = { phase: 'ready', replay: false, record: false, timecode: '', stopAt: 0, startAt: '' };
let recording = null;
let segments = [];
let segmentIndex = 0;
let captureReady = null;
let updateInfo = null;
let gpuEngine = null;
let gpuFailed = false;
let audioTracks = {};
let workingCandidate = '';
let videoStartMs = 0;
let overlayWin = null;
let overlayTimer = null;
let timerWin = null;
let processNames = new Set();
const helpers = {};
let fallbackActive = false;

const home = () => app.getPath('userData');
const replayDir = () => path.join(home(), 'replay');
const settingsPath = () => path.join(home(), 'settings.json');
const ffmpegPath = () => (testMode && process.env.CLFED_FFMPEG) || path.join(process.resourcesPath, 'ffmpeg.exe');
const helperPath = () => (testMode && process.env.CLFED_AUDIO_HELPER) || path.join(process.resourcesPath, 'clfed-audio.exe');
const log = (message) => {
  try { fs.appendFileSync(path.join(home(), 'app.log'), `${new Date().toISOString()}  ${message}\n`); } catch { /* logging must never break the app */ }
};
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const notify = (key, tone = 'info', detail = '') => send('toast', { key, tone, detail });
const tr = (key) => I18N[settings.language][key];
const pad = (n) => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function announce(key, kind) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const display = screen.getAllDisplays().find((item) => String(item.id) === settings.monitorValue) || screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
  overlayWin.setBounds({ x: x + width - OVERLAY_SIZE.width - 12, y: y + 12 + TIMER_SIZE.height + 6, ...OVERLAY_SIZE });
  overlayWin.webContents.send('show', { title: tr(key), kind, dir: settings.language === 'ar' ? 'rtl' : 'ltr' });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.showInactive();
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => overlayWin.hide(), 3000);
}
function updateTimerWindow() {
  if (!timerWin || timerWin.isDestroyed()) return;
  if (!state.record || !settings.showRecordTimer) { timerWin.hide(); return; }
  const display = screen.getAllDisplays().find((item) => String(item.id) === settings.monitorValue) || screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
  timerWin.setBounds({ x: x + width - TIMER_SIZE.width - 12, y: y + 12, ...TIMER_SIZE });
  timerWin.webContents.send('time', state.timecode || '00:00:00');
  if (!timerWin.isVisible()) {
    timerWin.setAlwaysOnTop(true, 'screen-saver');
    timerWin.showInactive();
  }
}
function setState(next) { state = { ...state, ...next }; send('state', state); updateTimerWindow(); }

function loadSettings() {
  const defaults = {
    clipsFolder: path.join(app.getPath('videos'), 'CLFED Capture'), replaySeconds: 60, resolution: '1080', fps: 60,
    monitorValue: '', showRecordTimer: true, audioSyncMs: -80, captureMode: 'screen', windowName: '', onlyGaming: false, customGames: '',
    audioMode: 'separate', systemOn: true, systemVolume: 100, micDevice: '', micVolume: 100, discordVolume: 100, appsVolume: 100,
    hotkeys: { ...DEFAULT_HOTKEYS }, autoReplay: true, mic: true, recordSeconds: 0, lastRecordSeconds: 60, storageLimitGB: 0, openAtLogin: false,
    language: app.getLocale().startsWith('ar') ? 'ar' : 'en',
  };
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { /* first run */ }
  if (saved.recordMinutes !== undefined && saved.recordSeconds === undefined) {
    saved.recordSeconds = Math.min(saved.recordMinutes * 60, 1800);
    if (saved.recordSeconds) saved.lastRecordSeconds = saved.recordSeconds;
  }
  const merged = { ...defaults, ...saved };
  merged.fps = Math.min(merged.fps, 60);
  delete merged.recordMinutes;
  delete merged.quality;
  delete merged.audioOffsetMs;
  if (merged.customSoundFile) fs.rmSync(merged.customSoundFile, { force: true });
  for (const key of ['alertSound', 'customSoundFile', 'customSoundName', 'customSoundVersion']) delete merged[key];
  return merged;
}
function saveSettings() {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function monitors() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => {
    const width = Math.round(display.size.width * display.scaleFactor);
    const height = Math.round(display.size.height * display.scaleFactor);
    return { value: String(display.id), width, height, primary: display.id === primary };
  });
}

async function findSource() {
  if (settings.captureMode === 'window') {
    const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const match = windows.find((item) => item.name === settings.windowName);
    if (match) return match;
    notify('windowMissing', 'warn');
  }
  return findScreen();
}
async function findScreen() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const wanted = settings.monitorValue || String(screen.getPrimaryDisplay().id);
  const source = sources.find((item) => item.display_id === wanted) || sources.find((item) => item.display_id === String(screen.getPrimaryDisplay().id)) || sources[0];
  if (!source) throw new Error('noScreen');
  return source;
}

async function captureConfig() {
  const source = await findSource();
  const [width, height] = RESOLUTIONS[settings.resolution] || RESOLUTIONS[1080];
  const bitrate = Math.round(width * height * settings.fps * BITS_PER_PIXEL);
  const screenSource = source.id.startsWith('window:') ? await findScreen() : null;
  return {
    sourceId: source.id, audioSourceId: screenSource ? screenSource.id : '', width, height, fps: settings.fps, bitrate,
    audioMode: settings.audioMode, systemOn: settings.systemOn, micOn: settings.mic, micDevice: settings.micDevice,
    systemVolume: settings.systemVolume / 100, micVolume: settings.micVolume / 100, discordVolume: settings.discordVolume / 100, appsVolume: settings.appsVolume / 100,
  };
}

async function command(name, config) {
  await captureReady;
  return new Promise((resolve, reject) => {
    const id = nextCommand++;
    pendingCommands.set(id, { resolve, reject });
    captureWin.webContents.send('cmd', { id, name, config });
    setTimeout(() => { if (pendingCommands.delete(id)) reject(new Error(`${name}: timeout`)); }, 20000);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    // Saving must not compete with the game.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the process may already be finished */ }
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errors.slice(-400) || `ffmpeg ${code}`))));
  });
}

function stopHelpers() {
  for (const name of Object.keys(helpers)) { helpers[name].kill(); delete helpers[name]; }
}
function startHelper(name, mode) {
  const child = spawn(helperPath(), [mode, ...DISCORD_EXES], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  helpers[name] = child;
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_HIGH); } catch (error) { log(error.message); }
  let pending = [];
  let pendingBytes = 0;
  child.stdout.on('data', (data) => {
    if (gpuEngine) { appendAudio(name, data); return; }
    pending.push(data);
    pendingBytes += data.length;
    if (pendingBytes < PCM_BATCH_BYTES) return;
    const batch = Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('pcm', { name, data: new Uint8Array(batch).buffer });
  });
  child.on('error', (error) => log(`audio helper: ${error.message}`));
  child.on('close', (code) => {
    if (helpers[name] !== child) return;
    delete helpers[name];
    if (code === 3) return;  // Discord is closed, which is normal.
    log(`audio helper ${name} stopped: ${code}`);
    if (name === 'apps' && !fallbackActive && (state.replay || state.record)) {
      fallbackActive = true;
      command('setFallback', true).catch(fail);
      notify('audioFallback', 'warn');
    }
  });
}
function hasDiscord() { return DISCORD_EXES.some((exe) => processNames.has(exe.toLowerCase())); }
function syncHelpers() {
  const wanted = settings.audioMode === 'separate' && (state.replay || state.record || Boolean(gpuEngine));
  if (!wanted) { stopHelpers(); fallbackActive = false; return; }
  if (!fallbackActive && !helpers.apps) startHelper('apps', 'exclude');
  if (hasDiscord() && !helpers.discord) startHelper('discord', 'include');
}
function isNewer(remote, current) {
  const a = String(remote).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}
async function checkForUpdate() {
  const response = await net.fetch(`${UPDATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return;
  const info = await response.json();
  if (!info.version || !info.url || !/^[a-f0-9]{64}$/.test(info.sha256 || '')) return;
  if (!testMode && !info.url.startsWith(UPDATE_PREFIX)) return;
  if (!isNewer(info.version, app.getVersion())) return;
  updateInfo = info;
  setState({ update: { version: info.version, phase: 'available', progress: 0 } });
}
async function installUpdate() {
  if (!updateInfo || state.update.phase === 'downloading') return;
  if (recording) throw new Error('stopFirst');
  const target = path.join(app.getPath('temp'), `CLFED-Capture-Update-${updateInfo.version}.exe`);
  const setUpdate = (next) => setState({ update: { ...state.update, ...next } });
  setUpdate({ phase: 'downloading', progress: 0 });
  try {
    const response = await net.fetch(updateInfo.url);
    if (!response.ok) throw new Error(`Update download failed: ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const file = fs.createWriteStream(target);
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      hash.update(value);
      if (!file.write(Buffer.from(value))) await new Promise((resolve) => file.once('drain', resolve));
      if (total) setUpdate({ progress: Math.round((received / total) * 100) });
    }
    await new Promise((resolve) => file.end(resolve));
    if (hash.digest('hex') !== updateInfo.sha256) throw new Error('Update file did not match its checksum');
  } catch (error) {
    fs.rmSync(target, { force: true });
    setUpdate({ phase: 'available', progress: 0 });
    log(error.message);
    throw new Error('updateFailed');
  }
  setUpdate({ phase: 'installing', progress: 100 });
  if (testMode) return;
  spawn(target, ['/AUTO'], { detached: true, stdio: 'ignore' }).unref();
  quitting = true;
  app.quit();
}

function listProcesses() {
  return new Promise((resolve) => {
    if (testMode && process.env.CLFED_TEST_PROCS) {
      fs.readFile(process.env.CLFED_TEST_PROCS, 'utf8', (_e, text) => resolve((text || '').split('\n').map((x) => x.trim()).filter(Boolean)));
      return;
    }
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8e6 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(stdout.split('\n').map((line) => line.split('","')[0].replace(/^"/, '').trim()).filter(Boolean));
    });
  });
}
const gamingOnly = () => settings.onlyGaming || settings.captureMode === 'games';
function runningGame() {
  const custom = settings.customGames.split(',').map((name) => name.trim()).filter(Boolean);
  return [...KNOWN_GAMES, ...custom].find((name) => processNames.has(name.toLowerCase())) || '';
}
async function pollProcesses() {
  const hadDiscord = hasDiscord();
  processNames = new Set((await listProcesses()).map((name) => name.toLowerCase()));
  if (hadDiscord !== hasDiscord() && (state.replay || state.record) && settings.audioMode === 'separate') {
    stopHelpers();
    fallbackActive = false;
    await command('setFallback', false).catch(fail);
  }
  syncHelpers();
  const game = runningGame();
  setState({ game, waiting: gamingOnly() && settings.autoReplay && !game });
  if (gamingOnly() && settings.autoReplay && !state.record) {
    if (game && !state.replay) await startReplay().catch(fail);
    else if (!game && state.replay) await stopReplay().catch(fail);
  }
}

const useGpu = () => settings.captureMode !== 'window' && !gpuFailed && (!testMode || Boolean(process.env.CLFED_TEST_VIDEO_ARGS));
const gpuDir = () => path.join(home(), 'gpu');

function chosenDisplay() {
  const primary = screen.getPrimaryDisplay();
  const chosen = screen.getAllDisplays().find((item) => String(item.id) === settings.monitorValue) || primary;
  // Windows lists the primary screen first, then the others from left to right.
  const others = screen.getAllDisplays().filter((item) => item.id !== primary.id).sort((a, b) => a.bounds.x - b.bounds.x);
  const index = chosen.id === primary.id ? 0 : others.findIndex((item) => item.id === chosen.id) + 1;
  return { index, width: Math.round(chosen.size.width * chosen.scaleFactor), height: Math.round(chosen.size.height * chosen.scaleFactor) };
}

function even(value) { return Math.round(value / 2) * 2; }

function captureSize() {
  const [boxWidth, boxHeight] = RESOLUTIONS[settings.resolution] || RESOLUTIONS[1080];
  const display = chosenDisplay();
  const scale = Math.min(1, boxWidth / display.width, boxHeight / display.height);
  return { display, scale, width: even(display.width * scale), height: even(display.height * scale) };
}

// Tried in order, because a failed start is the only reliable sign of what the PC supports.
function gpuCandidates() {
  if (testMode) return ['test'];
  return ['nvenc', 'amf'];
}

function gpuArgs(candidate) {
  const target = path.join(gpuDir(), 'seg%08d.ts');
  const { display } = captureSize();
  const fps = settings.fps;
  const bitrate = Math.min(GPU_MAX_BITRATE, Math.round(display.width * display.height * fps * GPU_BITS_PER_PIXEL));
  let input;
  let encoder;
  if (candidate === 'test') {
    input = process.env.CLFED_TEST_VIDEO_ARGS.replace('{DISPLAY}', process.env.DISPLAY || ':0').split('|');
    encoder = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(fps), '-b:v', String(bitrate)];
  } else {
    input = ['-f', 'lavfi', '-i', `ddagrab=output_idx=${display.index}:framerate=${fps}`];
    const shared = ['-b:v', String(bitrate), '-g', String(fps), '-bf', '0'];
    if (candidate === 'amf') encoder = ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cbr', ...shared];
    else encoder = ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll', '-rc', 'cbr', '-maxrate', String(bitrate), '-bufsize', String(bitrate), '-no-scenecut', '1', ...shared];
  }
  return ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-an', ...encoder, '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', target];
}

// Each sound source is stored with its real arrival time, so a slow game cannot push it out of step.
function trackFile(track, bucket) {
  return path.join(gpuDir(), `a-${track.name}-${String(bucket).padStart(8, '0')}.pcm`);
}
function writeTrack(track, data) {
  const bucket = Math.floor(track.bytes / AUDIO_BUCKET_BYTES);
  if (bucket !== track.bucket) {
    if (track.stream) track.stream.end();
    track.bucket = bucket;
    track.stream = fs.createWriteStream(trackFile(track, bucket), { flags: 'a' });
    track.stream.on('error', (error) => log(error.message));
  }
  track.stream.write(data);
  track.bytes += data.length;
}
function trackGain(name) {
  if (name === 'mix') return 1;
  return settings[`${name}Volume`] / 100;
}
function appendAudio(name, chunk) {
  if (!gpuEngine) return;
  let track = audioTracks[name];
  const bytes = Buffer.from(chunk);
  if (!track) {
    track = { name, startMs: Date.now() - (bytes.length / PCM_BYTES_PER_SECOND) * 1000, bytes: 0, bucket: -1, stream: null, carry: Buffer.alloc(0) };
    audioTracks[name] = track;
  }
  const whole = Buffer.concat([track.carry, bytes]);
  const usable = whole.length - (whole.length % 4);
  track.carry = whole.subarray(usable);
  const data = Buffer.from(whole.subarray(0, usable));
  const gain = trackGain(name);
  if (gain !== 1) {
    for (let i = 0; i + 1 < data.length; i += 2) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE(i) * gain))), i);
  }
  // Sources send nothing during silence, and a busy PC can deliver late. The clock decides the position.
  const expected = Math.floor((((Date.now() - track.startMs) / 1000) * PCM_BYTES_PER_SECOND) / 4) * 4 - data.length;
  const gap = expected - track.bytes;
  if (gap > AUDIO_RESYNC_BYTES) writeTrack(track, Buffer.alloc(Math.min(gap, AUDIO_BUCKET_BYTES)));
  writeTrack(track, data);
}
function closeAudioTracks() {
  for (const track of Object.values(audioTracks)) if (track.stream) track.stream.end();
  audioTracks = {};
}

async function writeAudioSlice(track, fromMs, toMs, target) {
  const align = (value) => Math.floor(value / 4) * 4;
  const start = align(((fromMs - track.startMs) / 1000) * PCM_BYTES_PER_SECOND);
  const end = align(((toMs - track.startMs) / 1000) * PCM_BYTES_PER_SECOND);
  const output = await fs.promises.open(target, 'w');
  try {
    if (start < 0) await output.write(Buffer.alloc(-start));
    for (let bucket = Math.floor(Math.max(0, start) / AUDIO_BUCKET_BYTES); bucket * AUDIO_BUCKET_BYTES < end; bucket++) {
      const data = await fs.promises.readFile(trackFile(track, bucket)).catch(() => null);
      if (!data) continue;
      const base = bucket * AUDIO_BUCKET_BYTES;
      await output.write(data.subarray(Math.max(0, start - base), Math.max(0, Math.min(data.length, end - base))));
    }
  } finally { await output.close(); }
}

function gpuSegments() {
  try { return fs.readdirSync(gpuDir()).filter((name) => name.startsWith('seg') && name.endsWith('.ts')).sort(); } catch { return []; }
}
const segmentNumber = (name) => Number(name.slice(3, 11));

function trimGpuSegments() {
  if (!gpuEngine) return;
  const files = gpuSegments();
  if (!files.length) return;
  const newest = segmentNumber(files[files.length - 1]);
  let keepFrom = state.replay ? newest - settings.replaySeconds - 2 : newest - 1;
  if (recording && recording.firstSegment !== undefined) keepFrom = Math.min(keepFrom, recording.firstSegment);
  for (const name of files) if (segmentNumber(name) < keepFrom) fs.rmSync(path.join(gpuDir(), name), { force: true });
  const keepMs = videoStartMs + keepFrom * 1000;
  for (const track of Object.values(audioTracks)) {
    const keepBucket = Math.floor((((keepMs - track.startMs) / 1000) * PCM_BYTES_PER_SECOND) / AUDIO_BUCKET_BYTES) - 1;
    for (let bucket = track.trimmed || 0; bucket < keepBucket; bucket++) fs.rmSync(trackFile(track, bucket), { force: true });
    track.trimmed = Math.max(track.trimmed || 0, keepBucket);
  }
}

async function tryGpuCandidate(candidate) {
  const child = spawn(ffmpegPath(), gpuArgs(candidate), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  gpuEngine = child;
  let errors = '';
  child.stderr.on('data', (data) => { errors = (errors + data).slice(-800); });
  const exited = new Promise((resolve) => child.on('close', resolve));
  child.on('error', (error) => { errors += error.message; });
  child.on('close', (code) => {
    if (gpuEngine !== child) return;
    gpuEngine = null;
    log(`GPU capture stopped (${code}): ${errors}`);
  });
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_HIGH); } catch (error) { log(error.message); }
  const deadline = Date.now() + GPU_START_MS;
  while (Date.now() < deadline && gpuEngine === child && !gpuSegments().length) await new Promise((resolve) => setTimeout(resolve, 50));
  if (gpuEngine === child && gpuSegments().length) {
    videoStartMs = Date.now();
    log(`GPU capture running: ${candidate}, ${captureSize().display.width}x${captureSize().display.height}, ${settings.fps} fps`);
    return true;
  }
  log(`GPU capture failed with ${candidate}: ${errors}`);
  gpuEngine = null;
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  return false;
}

async function startGpuEngine() {
  if (gpuEngine) return;
  fs.rmSync(gpuDir(), { recursive: true, force: true });
  fs.mkdirSync(gpuDir(), { recursive: true });
  closeAudioTracks();
  await command('startAudio', await captureConfig());
  const candidates = workingCandidate ? [workingCandidate] : gpuCandidates();
  for (const candidate of candidates) {
    fs.rmSync(gpuDir(), { recursive: true, force: true });
    fs.mkdirSync(gpuDir(), { recursive: true });
    if (await tryGpuCandidate(candidate)) {
      workingCandidate = candidate;
      syncHelpers();
      return;
    }
  }
  gpuFailed = true;
  fs.rmSync(gpuDir(), { recursive: true, force: true });
  await command('stopAudio').catch(fail);
  syncHelpers();
  notify('gpuFallback', 'warn');
  throw new Error(GPU_RETRY);
}

async function stopGpuEngineIfIdle() {
  if (!gpuEngine || state.replay || recording) return;
  const child = gpuEngine;
  gpuEngine = null;
  child.kill();
  await command('stopAudio').catch(fail);
  syncHelpers();
  closeAudioTracks();
  fs.rmSync(gpuDir(), { recursive: true, force: true });
}

async function joinSegments(names, target, seconds) {
  const joined = path.join(gpuDir(), `join-${Date.now()}.mpg`);
  const output = fs.createWriteStream(joined);
  for (const name of names) {
    if (!output.write(await fs.promises.readFile(path.join(gpuDir(), name)))) await new Promise((resolve) => output.once('drain', resolve));
  }
  await new Promise((resolve) => output.end(resolve));
  const firstMs = videoStartMs + segmentNumber(names[0]) * 1000;
  const lastMs = videoStartMs + (segmentNumber(names[names.length - 1]) + 1) * 1000;
  const tracks = Object.values(audioTracks);
  const inputs = [];
  const sounds = [];
  for (const track of tracks) {
    const sound = `${joined}.${track.name}.pcm`;
    await writeAudioSlice(track, firstMs + settings.audioSyncMs, lastMs + settings.audioSyncMs, sound);
    sounds.push(sound);
    inputs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', sound);
  }
  const labels = tracks.map((_track, index) => `[${index + 1}:a]`).join('');
  const mixing = tracks.length > 1 ? `${labels}amix=inputs=${tracks.length}:normalize=0:duration=longest,` : labels;
  const audioOutput = tracks.length ? ['-filter_complex', `${mixing}alimiter=limit=0.95[sound]`, '-map', '0:v', '-map', '[sound]', '-c:a', 'aac', '-b:a', '192k'] : [];
  const limit = seconds > 0 ? ['-t', String(seconds)] : [];
  await runFfmpeg(['-f', 'mpegts', '-i', joined, ...inputs, ...audioOutput, ...limit, '-c:v', 'copy', '-movflags', '+faststart', target]);
  fs.rmSync(joined, { force: true });
  sounds.forEach((sound) => fs.rmSync(sound, { force: true }));
}

async function startReplay() {
  if (state.replay) return;
  if (useGpu()) {
    try {
      await startGpuEngine();
      setState({ replay: true });
      return;
    } catch (error) {
      if (error.message !== GPU_RETRY) throw error;
    }
  }
  fs.rmSync(replayDir(), { recursive: true, force: true });
  fs.mkdirSync(replayDir(), { recursive: true });
  segments = [];
  await command('startReplay', await captureConfig());
  setState({ replay: true });
  syncHelpers();
}
async function stopReplay() {
  if (!state.replay) return;
  if (gpuEngine) {
    setState({ replay: false });
    await stopGpuEngineIfIdle();
    return;
  }
  await command('stopReplay');
  setState({ replay: false });
  syncHelpers();
  segments = [];
  fs.rmSync(replayDir(), { recursive: true, force: true });
}
async function saveReplay() {
  if (!state.replay) { notify('replayFirst', 'warn'); return; }
  if (gpuEngine) {
    const names = gpuSegments().slice(0, -1).slice(-settings.replaySeconds);
    if (!names.length) { notify('waitReplay', 'warn'); return; }
    announce('savedReplay', 'replay');
    await joinSegments(names, path.join(settings.clipsFolder, `Replay ${stamp()}.mp4`), 0);
    return;
  }
  await command('flushReplay');
  if (!segments.length) { notify('waitReplay', 'warn'); return; }
  const count = Math.ceil(settings.replaySeconds / SEGMENT_SECONDS);
  const parts = segments.slice(-count);
  const files = parts;
  const list = path.join(replayDir(), `list-${Date.now()}.txt`);
  fs.writeFileSync(list, files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const target = path.join(settings.clipsFolder, `Replay ${stamp()}.mp4`);
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target]);
  fs.rmSync(list, { force: true });
  announce('savedReplay', 'replay');
}

async function startGpuRecord() {
  await startGpuEngine();
  const files = gpuSegments();
  recording = { started: Date.now(), timer: null, firstSegment: segmentNumber(files[files.length - 1]) + 1 };
  const limit = (Number(settings.recordSeconds) || 0) * 1000;
  if (limit > 0) recording.timer = setTimeout(() => stopRecord().catch(fail), limit);
  announce('recordStarted', 'record');
  setState({ record: true, timecode: '00:00:00', stopAt: limit > 0 ? recording.started + limit : 0 });
}
async function stopGpuRecord() {
  const current = recording;
  clearTimeout(current.timer);
  const seconds = (Date.now() - current.started) / 1000;
  announce('savedRecord', 'saved');
  setState({ record: false, timecode: '', stopAt: 0 });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const names = gpuSegments().slice(0, -1).filter((name) => segmentNumber(name) >= current.firstSegment);
  try {
    if (names.length) await joinSegments(names, path.join(settings.clipsFolder, `Recording ${stamp()}.mp4`), seconds);
  } finally {
    recording = null;
    await stopGpuEngineIfIdle();
  }
}

async function startRecord() {
  if (recording) return;
  if (useGpu()) {
    try {
      await startGpuRecord();
      return;
    } catch (error) {
      recording = null;
      if (error.message !== GPU_RETRY) throw error;
    }
  }
  const raw = path.join(settings.clipsFolder, `Recording ${stamp()}.webm`);
  recording = { raw, stream: fs.createWriteStream(raw), started: Date.now(), timer: null };
  recording.stream.on('error', (error) => log(error.message));
  await command('startRecord', await captureConfig());
  setState({ record: true });
  syncHelpers();
  const limit = (Number(settings.recordSeconds) || 0) * 1000;
  recording.started = Date.now();
  if (limit > 0) recording.timer = setTimeout(() => stopRecord().catch(fail), limit);
  announce('recordStarted', 'record');
  setState({ record: true, timecode: '00:00:00', stopAt: limit > 0 ? recording.started + limit : 0 });
}
async function stopRecord() {
  if (!recording) return;
  if (recording.firstSegment !== undefined) { await stopGpuRecord(); return; }
  const current = recording;
  clearTimeout(current.timer);
  await command('stopRecord');
  await new Promise((resolve) => current.stream.end(resolve));
  recording = null;
  setState({ record: false, timecode: '', stopAt: 0 });
  syncHelpers();
  const target = current.raw.replace(/\.webm$/, '.mp4');
  try {
    await runFfmpeg(['-i', current.raw, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target]);
    fs.rmSync(current.raw, { force: true });
  } catch (error) { log(`Kept the original file: ${error.message}`); }
  announce('savedRecord', 'saved');
}
async function trimClip(file, { start, end }) {
  const from = Math.max(0, Number(start) || 0);
  const length = (Number(end) || 0) - from;
  if (length < 0.1) throw new Error('badTrim');
  const parsed = path.parse(file);
  let target = path.join(parsed.dir, `${parsed.name} (trim).mp4`);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(parsed.dir, `${parsed.name} (trim ${i}).mp4`);
  await runFfmpeg(['-ss', String(from), '-i', file, '-t', String(length), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target]);
}

async function screenshot() {
  announce('savedShot', 'shot');
  const display = screen.getAllDisplays().find((item) => String(item.id) === settings.monitorValue) || screen.getPrimaryDisplay();
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
  await fs.promises.writeFile(path.join(settings.clipsFolder, `Screenshot ${stamp()}.png`), source.thumbnail.toPNG());
}

function fail(error) { log(error.stack || error.message); send('toast', { key: I18N.ar[error.message] ? error.message : '', text: error.message, tone: 'warn' }); }
const actions = {
  saveReplay,
  toggleReplay: async () => {
    const enable = !state.replay;
    settings.autoReplay = enable;
    saveSettings();
    setState({ autoReplay: enable });
    if (enable) await startReplay(); else await stopReplay();
  },
  toggleRecord: () => (state.record ? stopRecord() : startRecord()),
  screenshot,
  installUpdate,
  schedule: async (time) => { setState({ startAt: time || '' }); },
};

function listClips() {
  let names = [];
  try { names = fs.readdirSync(settings.clipsFolder); } catch { return []; }
  const clips = [];
  for (const name of names) {
    if (!CLIP_EXT.has(path.extname(name).toLowerCase())) continue;
    const file = path.join(settings.clipsFolder, name);
    if (recording && recording.raw === file) continue;
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) clips.push({ name, file, url: pathToFileURL(file).href, size: stat.size, time: stat.mtimeMs, image: name.toLowerCase().endsWith('.png') });
    } catch { /* a file can vanish while listing */ }
  }
  return clips.sort((a, b) => b.time - a.time);
}

// Off unless the user sets a limit. The newest clip is always kept.
async function enforceStorageLimit() {
  const limit = settings.storageLimitGB * 1024 ** 3;
  if (limit <= 0) return;
  const clips = listClips();
  let total = clips.reduce((sum, clip) => sum + clip.size, 0);
  for (let i = clips.length - 1; i >= 1 && total > limit; i--) {
    try { await shell.trashItem(clips[i].file); total -= clips[i].size; } catch (error) { log(error.message); }
  }
}
function isClip(file) {
  return path.dirname(path.resolve(file)) === path.resolve(settings.clipsFolder) && CLIP_EXT.has(path.extname(file).toLowerCase());
}

function createWindows() {
  const icon = path.join(__dirname, '..', 'build', 'icon.ico');
  win = new BrowserWindow({
    width: 1120, height: 720, minWidth: 900, minHeight: 620, backgroundColor: '#0a0d12', show: false, title: 'CLFED Capture', icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (!process.argv.includes('--hidden')) win.once('ready-to-show', () => win.show());
  win.on('close', (event) => { if (!quitting) { event.preventDefault(); win.hide(); } });
  captureWin = new BrowserWindow({
    show: false, webPreferences: { preload: path.join(__dirname, 'preload-capture.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlayWin = new BrowserWindow({
    ...OVERLAY_SIZE, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  overlayWin.setIgnoreMouseEvents(true);
  // Keeps the notice out of the video and out of screenshots.
  overlayWin.setContentProtection(true);
  overlayWin.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
  timerWin = new BrowserWindow({
    ...TIMER_SIZE, show: false, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  timerWin.setIgnoreMouseEvents(true);
  timerWin.setContentProtection(true);
  timerWin.loadFile(path.join(__dirname, 'ui', 'timer.html'));
  captureReady = new Promise((resolve) => captureWin.webContents.once('did-finish-load', resolve));
  captureWin.loadFile(path.join(__dirname, 'ui', 'capture.html'));
  return captureReady;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.ico')));
  tray.setToolTip('CLFED Capture');
  const open = () => { win.show(); win.focus(); };
  tray.on('click', open);
  renderTrayMenu();
}
function renderTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('trayOpen'), click: () => { win.show(); win.focus(); } },
    { label: tr('traySave'), click: () => saveReplay().catch(fail) },
    { type: 'separator' },
    { label: tr('trayQuit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function hotkeyRun(name) {
  return () => actions[name]().catch(fail);
}
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed = Object.entries(settings.hotkeys).filter(([name, key]) => {
    try { return !globalShortcut.register(key, hotkeyRun(name)); } catch { return true; }
  }).map(([, key]) => key);
  if (failed.length) notify('hotkeysBusy', 'warn', failed.join(', '));
}

function tick() {
  trimGpuSegments();
  if (recording) {
    const seconds = Math.floor((Date.now() - recording.started) / 1000);
    setState({ timecode: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` });
  }
  if (state.startAt) {
    const now = new Date();
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` === state.startAt) {
      setState({ startAt: '' });
      if (!recording) startRecord().catch(fail);
      send('schedule-done');
    }
  }
}

ipcMain.on('cmd-reply', (_e, id, result) => {
  const pending = pendingCommands.get(id);
  if (!pending) return;
  pendingCommands.delete(id);
  if (result.ok) pending.resolve(result.value); else pending.reject(new Error(result.error));
});
ipcMain.handle('rec-chunk', (_e, data) => new Promise((resolve) => {
  if (!recording) { resolve(); return; }
  recording.stream.write(Buffer.from(data), () => resolve());
}));
ipcMain.handle('rec-segment', (_e, data) => {
  if (!data.byteLength || !state.replay) return;
  const file = path.join(replayDir(), `seg-${segmentIndex++}.webm`);
  fs.writeFileSync(file, Buffer.from(data));
  segments.push(file);
  const keep = Math.ceil(settings.replaySeconds / SEGMENT_SECONDS) + 1;
  while (segments.length > keep) {
    fs.rmSync(segments.shift(), { force: true });
  }
});
ipcMain.on('source-ended', () => {
  notify('sourceEnded', 'warn');
  stopRecord().catch(fail);
  stopReplay().catch(fail);
});
ipcMain.on('mix-pcm', (_e, data) => {
  appendAudio('mix', data);
});
ipcMain.on('rec-failed', (_e, message) => { log(message); notify('recordProblem', 'warn', message); });

ipcMain.handle('save-timing', (_e, timing) => {
  Object.assign(settings, {
    recordSeconds: Math.min(Math.max(0, Number(timing.recordSeconds) || 0), 1800),
    lastRecordSeconds: Number(timing.lastRecordSeconds) || 60,
    replaySeconds: Math.min(Math.max(5, Number(timing.replaySeconds) || 60), 1800),
  });
  saveSettings();
});
ipcMain.handle('set-language', (_e, language) => {
  if (!I18N[language]) return;
  settings.language = language;
  saveSettings();
  renderTrayMenu();
});
ipcMain.handle('init', () => ({ settings, state, monitors: monitors(), author: 'Talal (CLFED)', version: app.getVersion(), defaults: DEFAULT_HOTKEYS }));
ipcMain.handle('set-audio-offset', (_e, value) => {
  settings.audioSyncMs = Math.min(800, Math.max(-800, Number(value) || 0));
  saveSettings();
});
ipcMain.handle('set-startup', (_e, enabled) => {
  settings.openAtLogin = Boolean(enabled);
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
  saveSettings();
  return settings.openAtLogin;
});
ipcMain.handle('set-volume', async (_e, name, value) => {
  const volume = Math.min(200, Math.max(0, Number(value) || 0));
  settings[`${name}Volume`] = volume;
  saveSettings();
  if (state.replay || state.record || gpuEngine) await command('setGain', { name, value: volume / 100 });
});
ipcMain.handle('set-hotkey', (_e, name, accelerator) => {
  if (!DEFAULT_HOTKEYS[name]) return settings.hotkeys;
  if (Object.entries(settings.hotkeys).some(([other, key]) => other !== name && key === accelerator)) throw new Error('hotkeyTaken');
  const previous = settings.hotkeys[name];
  settings.hotkeys = { ...settings.hotkeys, [name]: accelerator };
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(accelerator, hotkeyRun(name)); } catch { ok = false; }
  if (!ok) settings.hotkeys[name] = previous;
  registerHotkeys();
  saveSettings();
  if (!ok) throw new Error('hotkeyTaken');
  return settings.hotkeys;
});
ipcMain.handle('reset-hotkeys', () => {
  settings.hotkeys = { ...DEFAULT_HOTKEYS };
  registerHotkeys();
  saveSettings();
  return settings.hotkeys;
});
ipcMain.handle('list-windows', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  return sources.filter((source) => source.name && source.name !== 'CLFED Capture').map((source) => source.name);
});
ipcMain.handle('list-mics', () => command('listMics'));
ipcMain.handle('action', (_e, name, value) => actions[name](value));
ipcMain.handle('clips', () => {
  const clips = listClips();
  return { clips, total: clips.reduce((sum, clip) => sum + clip.size, 0), folder: settings.clipsFolder };
});
ipcMain.handle('clip', async (_e, name, file, value) => {
  if (!isClip(file)) return;
  if (name === 'open') await shell.openPath(file);
  else if (name === 'reveal') shell.showItemInFolder(file);
  else if (name === 'trash') await shell.trashItem(file);
  else if (name === 'rename') {
    const clean = String(value || '').trim();
    if (!clean || /[<>:"/\\|?*\x00-\x1f]/.test(clean)) throw new Error('badName');
    const target = path.join(path.dirname(file), clean + path.extname(file));
    if (fs.existsSync(target)) throw new Error('nameUsed');
    fs.renameSync(file, target);
  } else if (name === 'trim') await trimClip(file, value);
});
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.clipsFolder });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('apply', async (_e, next) => {
  if (recording) throw new Error('stopFirst');
  const restart = state.replay;
  await stopReplay();
  settings = { ...settings, ...next };
  saveSettings();
  fs.mkdirSync(settings.clipsFolder, { recursive: true });
  processNames = new Set((await listProcesses()).map((name) => name.toLowerCase()));
  if (!gamingOnly() || runningGame()) { if (restart || settings.autoReplay) await startReplay(); }
  await pollProcesses();
  return true;
});

if (!app.requestSingleInstanceLock()) {
  quitting = true;
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    settings = loadSettings();
    saveSettings();
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch (error) { log(error.message); }
    log(`Started ${app.getVersion()}`);
    fs.mkdirSync(settings.clipsFolder, { recursive: true });
    await createWindows();
    createTray();
    registerHotkeys();
    let lastList = '';
    setInterval(() => {
      tick();
      const next = listClips().map((clip) => `${clip.name}|${clip.size}`).join(';');
      if (next !== lastList) {
        lastList = next;
        send('clips-changed');
        enforceStorageLimit().catch(fail);
      }
    }, 1000);
    setInterval(() => pollProcesses().catch(fail), 5000);
    const update = () => checkForUpdate().catch((error) => log(`update check: ${error.message}`));
    setTimeout(update, 3000);
    setInterval(update, UPDATE_CHECK_MS);
    await pollProcesses().catch(fail);
    if (settings.autoReplay && !gamingOnly()) await startReplay().catch(fail);
  });
  app.on('before-quit', async (event) => {
    quitting = true;
    if (!app.clfedStopped) {
      event.preventDefault();
      app.clfedStopped = true;
      await stopRecord().catch(fail);
      await stopReplay().catch(fail);
      stopHelpers();
      app.quit();
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
