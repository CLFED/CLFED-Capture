'use strict';
const api = window.capture;
const SEGMENT_MS = 5000;
const MIME_TYPES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

let stream = null;
let audioContext = null;
let extraTracks = [];
let recordRecorder = null;
let replayOn = false;
let segment = null;
let segmentTimer = null;
let options = {};
let gains = {};
let pcmNodes = {};
let appsVolume = 1;

function desktopVideo(id, config) {
  return { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: config.width, maxHeight: config.height, maxFrameRate: config.fps } };
}

async function openDesktop(config) {
  const video = desktopVideo(config.sourceId, config);
  const audio = { mandatory: { chromeMediaSource: 'desktop' } };
  try { return await navigator.mediaDevices.getUserMedia({ video, audio }); }
  catch (error) { return navigator.mediaDevices.getUserMedia({ video, audio: false }); }
}

// Window capture cannot carry system audio, so that comes from a screen source.
async function openLoopback(config) {
  try {
    const screen = await navigator.mediaDevices.getUserMedia({
      video: desktopVideo(config.audioSourceId, { width: 320, height: 180, fps: 1 }), audio: { mandatory: { chromeMediaSource: 'desktop' } } });
    screen.getVideoTracks().forEach((track) => track.stop());
    return screen.getAudioTracks();
  } catch (error) { return []; }
}

async function openMic(config) {
  const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: false };
  if (config.micDevice) audio.deviceId = { exact: config.micDevice };
  try { return (await navigator.mediaDevices.getUserMedia({ audio })).getAudioTracks(); }
  catch (error) {
    api.failed(`mic: ${error.message}`);
    return [];
  }
}

function addGain(name, value, destination) {
  const node = audioContext.createGain();
  node.gain.value = value;
  node.connect(destination);
  gains[name] = node;
  return node;
}

async function ensureStream(config) {
  if (stream) return;
  const desktop = await openDesktop(config);
  const video = desktop.getVideoTracks()[0];
  video.addEventListener('ended', () => api.sourceEnded());
  let systemTracks = desktop.getAudioTracks();
  if (!systemTracks.length && config.audioSourceId) systemTracks = await openLoopback(config);
  const micTracks = config.micOn ? await openMic(config) : [];
  extraTracks = [...systemTracks, ...micTracks];

  audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.resume();
  const mix = audioContext.createMediaStreamDestination();
  gains = {};
  pcmNodes = {};
  appsVolume = config.appsVolume;
  const connect = (tracks, node) => {
    for (const track of tracks) audioContext.createMediaStreamSource(new MediaStream([track])).connect(node);
  };
  if (config.audioMode === 'separate') {
    await audioContext.audioWorklet.addModule('pcm-worklet.js');
    connect(systemTracks, addGain('fallback', 0, mix));
    for (const [name, volume] of [['apps', config.appsVolume], ['discord', config.discordVolume]]) {
      const node = new AudioWorkletNode(audioContext, 'pcm-source', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(addGain(name, volume, mix));
      pcmNodes[name] = node;
    }
  } else if (config.systemOn) {
    connect(systemTracks, addGain('system', config.systemVolume, mix));
  }
  if (micTracks.length) connect(micTracks, addGain('mic', config.micVolume, mix));
  stream = new MediaStream([video, ...mix.stream.getAudioTracks()]);
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  options = { mimeType, videoBitsPerSecond: config.bitrate, audioBitsPerSecond: 192000 };
}

function releaseStream() {
  if (recordRecorder || replayOn || !stream) return;
  stream.getTracks().forEach((track) => track.stop());
  extraTracks.forEach((track) => track.stop());
  if (audioContext) audioContext.close();
  stream = null; audioContext = null; extraTracks = []; gains = {}; pcmNodes = {};
}

function startSegment() {
  const parts = [];
  const recorder = new MediaRecorder(stream, options);
  const finished = new Promise((resolve) => {
    recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
    recorder.onstop = async () => {
      await api.segment(await new Blob(parts).arrayBuffer());
      resolve();
    };
  });
  recorder.onerror = (event) => api.failed(`replay: ${event.error && event.error.message}`);
  recorder.start();
  segment = { recorder, finished };
  segmentTimer = setTimeout(rotateSegment, SEGMENT_MS);
}

function rotateSegment() {
  clearTimeout(segmentTimer);
  const current = segment;
  segment = null;
  if (current && current.recorder.state !== 'inactive') current.recorder.stop();
  if (replayOn) startSegment();
  return current ? current.finished : Promise.resolve();
}

const commands = {
  async startReplay(config) {
    await ensureStream(config);
    if (replayOn) return;
    replayOn = true;
    startSegment();
  },
  async stopReplay() {
    replayOn = false;
    await rotateSegment();
    releaseStream();
  },
  flushReplay() { return rotateSegment(); },
  async startRecord(config) {
    await ensureStream(config);
    let queue = Promise.resolve();
    const recorder = new MediaRecorder(stream, options);
    recorder.ondataavailable = (event) => {
      if (event.data.size) queue = queue.then(async () => api.chunk(await event.data.arrayBuffer()));
    };
    recorder.onerror = (event) => api.failed(`record: ${event.error && event.error.message}`);
    recorder.stopped = new Promise((resolve) => { recorder.onstop = () => queue.then(resolve); });
    recordRecorder = recorder;
    recorder.start(1000);
    return options.mimeType;
  },
  async stopRecord() {
    const recorder = recordRecorder;
    if (!recorder) return;
    recorder.stop();
    await recorder.stopped;
    recordRecorder = null;
    releaseStream();
  },
  setGain({ name, value }) {
    if (name === 'apps') appsVolume = value;
    if (gains[name]) gains[name].gain.value = value;
    if (name === 'apps' && gains.fallback && gains.fallback.gain.value > 0) gains.fallback.gain.value = value;
  },
  setFallback(enabled) { if (gains.fallback) gains.fallback.gain.value = enabled ? appsVolume : 0; },
  async listMics() {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop()); }
    catch (error) { return []; }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput' && !['default', 'communications'].includes(device.deviceId))
      .map((device) => ({ id: device.deviceId, label: device.label }));
  },
};

api.onPcm(({ name, data }) => { if (pcmNodes[name]) pcmNodes[name].port.postMessage(data, [data]); });
api.onCommand(async ({ id, name, config }) => {
  try { api.reply(id, { ok: true, value: await commands[name](config) }); }
  catch (error) { api.reply(id, { ok: false, error: error.message }); }
});
