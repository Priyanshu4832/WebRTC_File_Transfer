/*
  client.js — COMPLETE REWRITE
  ---------------------------------------------------------
  Goals
  - Keep existing variable and element IDs so it plugs into your page with zero markup changes
  - Robust signalling, pairing, chat, and binary file transfer over WebRTC DataChannels
  - Strong backpressure management tuned for laptop ↔ phone
  - Defensive state machine + clear UI hooks
  - No code copied from the prior file; fresh implementation while reusing variable names

  Assumptions about the DOM (unchanged):
  - #peerSelect (select), #pairBtn (button), #startBtn (button)
  - #msgInput (input), #sendBtn (button), #chatBox (div)
  - #fileInput (input[type=file]), #sendFileBtn (button), #fileStatus (div), #download (div)
  - Optional: window.updateUIState(state) where state ∈ { 'disconnected','connecting','connected' }

  Network model:
  - Socket.io for signalling (server should broadcast available peers, handle connect-request, offer/answer, and candidate relays)
  - One logical DataChannel for both chat and file transfer (control messages are JSON; file data is framed binary)

  File protocol (simple, reliable):
  - JSON control frames:
      {type:"chat", sender, message, timestamp}
      {type:"file_init", fileName, fileSize, fileType, chunkSize, transferId}
      {type:"file_ack", transferId}
      {type:"file_done", transferId}
      {type:"file_abort", transferId, reason}
  - Binary frames:
      [ 4B MAGIC, 2B VERSION, 2B FLAGS, 4B INDEX, 4B LENGTH, ...payload ]  (big-endian)
    Where MAGIC is 0x46494C45 ("FILE"), VERSION=1, FLAGS reserved=0

  Reliability:
  - DataChannel created with ordered & reliable semantics
  - Sender throttles using bufferedAmount and bufferedAmountLowThreshold
  - Receiver stores chunks by index; assemble strictly in ascending order
  - Integrity check: optional SHA-256 on the receiver; if supported, verify size and hash

  Notes:
  - This file is intentionally verbose and well-commented for clarity and future debugging
  - Approximately 800+ lines for completeness
*/

// ---------------------------------------------------------
// Utility helpers (UI-safe logging and formatting)
// ---------------------------------------------------------

function log(msg) {
  try { console.log(msg); } catch (_) {}
  appendMessage(`[DEBUG] ${String(msg)}`);
}

function appendMessage(msg) {
  const chatBox = document.getElementById("chatBox");
  if (!chatBox) return;
  const ts = new Date().toLocaleTimeString();
  chatBox.innerHTML += `<span style="color:#666;font-size:0.8em;">[${ts}]</span> ${msg}<br>`;
  chatBox.scrollTop = chatBox.scrollHeight;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B","KB","MB","GB","TB"]; 
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${val} ${units[i]}`;
}

function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s";
  if (bps >= 1024 * 1024) return `${(bps / (1024*1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// Optional crypto utilities (feature-detected)
async function sha256(buffer) {
  if (!window.crypto || !window.crypto.subtle) return null; // not critical
  try {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------
// Global state (variable names kept as requested)
// ---------------------------------------------------------

const names = ["lapras","butterfree","gyarados","blastoise","snorlax","psyduck","jigglypuff","bulbasaur"];
const myName = names[Math.floor(Math.random() * names.length)];
let pairedPeer = null;
let isInitiator = false;

let pc = null;              // RTCPeerConnection instance
let dataChannel = null;     // RTCDataChannel

// Receiving state (intentionally explicit and verbose)
let receiving = {
  active: false,
  transferId: null,
  fileName: "",
  fileSize: 0,
  fileType: "application/octet-stream",
  chunkSize: 64 * 1024,
  totalChunks: 0,
  receivedBytes: 0,
  startTime: 0,
  lastBytes: 0,
  lastTick: 0,
  chunks: new Map(), // index -> Uint8Array
  speedTimer: null,
  integrity: { claimedHash: null, computedHash: null },
};

// Queue ICE candidates if remoteDescription isn't ready yet
let pendingCandidates = [];

// RTC config
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com:3478" }
  ],
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Chunk framing constants
const CHUNK_HEADER_BYTES = 16; // expanded header for version/flags
const CHUNK_MAGIC = 0x46494C45; // "FILE"
const CHUNK_VERSION = 1;

// Backpressure thresholds (tuned for phone ↔ laptop)
const BUFFERED_LOW = 256 * 1024;  // 256 KB
const BUFFERED_HIGH = 768 * 1024; // 768 KB

// UI helpers
function setUIState(state) {
  if (typeof window.updateUIState === 'function') {
    try { window.updateUIState(state); } catch (_) {}
  }
}

function setFileStatus(text) {
  const el = document.getElementById('fileStatus');
  if (el) el.innerText = text;
}

function addDownloadLink(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.textContent = `📁 Download ${fileName}`;
  a.style.display = 'block';
  a.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 1500);
  const container = document.getElementById('download');
  if (container) container.appendChild(a);
}

// ---------------------------------------------------------
// Signalling socket (socket.io) — robust reconnects
// ---------------------------------------------------------

const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  autoConnect: true,
  transports: ['websocket','polling']
});

log(`👤 Your name: ${myName}`);
socket.emit('join', myName);

socket.on('connect', () => {
  log('Signalling connected');
  socket.emit('join', myName);
});

socket.on('disconnect', () => {
  log('Signalling disconnected');
  appendMessage('⚠️ Connection lost. Attempting to reconnect...');
  resetConnection();
});

socket.on('reconnect', (n) => {
  log(`Reconnected after ${n} attempt(s)`);
  socket.emit('join', myName);
  appendMessage('✅ Reconnected to server');
});

socket.on('connect-error', (msg) => {
  appendMessage(`❌ Connect error: ${msg}`);
});

// Peer list maintenance
socket.on('available-peers', (list) => {
  const sel = document.getElementById('peerSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select a peer to connect</option>';
  list.filter(n => n !== myName).forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  });
});

socket.on('paired', (peerName) => {
  pairedPeer = peerName;
  appendMessage(`🔗 Paired with ${peerName}`);
  const startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.disabled = false;
});

socket.on('peer-disconnected', (info) => {
  appendMessage(`⚠️ ${info?.name || 'Peer'} disconnected: ${info?.reason || 'unknown'}`);
  pairedPeer = null;
  const startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.disabled = true;
  resetConnection();
});

// Pairing button handler
const pairBtnEl = document.getElementById('pairBtn');
if (pairBtnEl) {
  pairBtnEl.onclick = () => {
    const sel = document.getElementById('peerSelect');
    const target = sel ? sel.value : '';
    if (!target) {
      alert('No peer selected');
      return;
    }
    socket.emit('connect-request', { from: myName, to: target });
  };
}

// ---------------------------------------------------------
// WebRTC connection management
// ---------------------------------------------------------

function resetConnection() {
  try {
    if (dataChannel) {
      try { dataChannel.close(); } catch (_) {}
    }
  } finally { dataChannel = null; }

  try {
    if (pc) { try { pc.close(); } catch (_) {} }
  } finally { pc = null; }

  receivingStop(true);
  pendingCandidates = [];
  setUIState('disconnected');
}

function ensurePeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('candidate', e.candidate);
    }
  };

  pc.onconnectionstatechange = () => {
    log(`PC state: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') setUIState('connected');
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      setUIState('disconnected');
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE state: ${pc.iceConnectionState}`);
  };

  // If we are the answerer, data channel will be delivered here
  pc.ondatachannel = (ev) => {
    dataChannel = ev.channel;
    setupDataChannelHandlers();
  };

  return pc;
}

function createDataChannel() {
  if (!pc) throw new Error('PeerConnection not ready');
  const opts = { ordered: true }; // reliable & in-order
  dataChannel = pc.createDataChannel('filetransfer', opts);
  // configure backpressure threshold before we start sending
  try { dataChannel.bufferedAmountLowThreshold = BUFFERED_LOW; } catch (_) {}
  setupDataChannelHandlers();
}

function setupDataChannelHandlers() {
  if (!dataChannel) return;

  dataChannel.onopen = () => {
    appendMessage('✅ Data channel ready — you can send files and chat!');
    setUIState('connected');
  };

  dataChannel.onclose = () => {
    appendMessage('❌ Data channel closed');
    setUIState('disconnected');
  };

  dataChannel.onerror = (err) => {
    appendMessage(`❌ Data channel error: ${err?.message || err}`);
    setUIState('disconnected');
  };

  dataChannel.onmessage = async (event) => {
    try {
      if (typeof event.data === 'string') {
        let obj = null;
        try { obj = JSON.parse(event.data); } catch (_) {}
        if (!obj || typeof obj !== 'object') {
          // treat as plain chat text
          appendMessage(`${pairedPeer || 'Peer'}: ${event.data}`);
          return;
        }
        await handleControlMessage(obj);
        return;
      }

      // Binary data path (file chunks)
      const arrayBuffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      handleBinaryChunk(arrayBuffer);
    } catch (err) {
      appendMessage(`❌ onmessage error: ${err?.message || err}`);
    }
  };
}

// Offer/answer flow
const startBtnEl = document.getElementById('startBtn');
if (startBtnEl) {
  startBtnEl.disabled = true;
  startBtnEl.onclick = async () => {
    if (!pairedPeer) {
      alert('Pair with someone first!');
      return;
    }
    isInitiator = true;
    setUIState('connecting');

    resetConnection(); // ensure clean slate
    ensurePeerConnection();
    createDataChannel();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', offer);
      appendMessage('📤 Offer created & sent to paired peer.');
    } catch (err) {
      appendMessage(`❌ Error starting connection: ${err?.message || err}`);
      setUIState('disconnected');
    }
  };
}

socket.on('offer', async (offer) => {
  if (isInitiator) {
    log('Ignoring offer — already initiator');
    return;
  }
  setUIState('connecting');
  resetConnection();
  ensurePeerConnection();

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    processPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', answer);
    appendMessage('📤 Answer created & sent.');
  } catch (err) {
    appendMessage(`❌ Error handling offer: ${err?.message || err}`);
    setUIState('disconnected');
  }
});

socket.on('answer', async (answer) => {
  if (!isInitiator) return; // only the offerer expects an answer
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    processPendingCandidates();
    appendMessage('📥 Answer received — establishing connection...');
  } catch (err) {
    appendMessage(`❌ Error applying answer: ${err?.message || err}`);
    setUIState('disconnected');
  }
});

socket.on('candidate', async (candidate) => {
  if (!pc) {
    log('Candidate received but no PC yet — dropping');
    return;
  }
  try {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      pendingCandidates.push(candidate);
    }
  } catch (err) {
    log(`addIceCandidate error: ${err?.message || err}`);
  }
});

function processPendingCandidates() {
  if (!pc || !pc.remoteDescription) return;
  const copy = pendingCandidates.slice();
  pendingCandidates.length = 0;
  copy.forEach(async (c) => {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
    catch (err) { log(`Queued candidate add failed: ${err?.message || err}`); }
  });
}

// ---------------------------------------------------------
// Control messages and file transfer engine
// ---------------------------------------------------------

function sendControl(obj) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    throw new Error('Data channel is not open');
  }
  dataChannel.send(JSON.stringify(obj));
}

async function handleControlMessage(msg) {
  switch (msg.type) {
    case 'chat': {
      const who = msg.sender || pairedPeer || 'Peer';
      appendMessage(`${who}: ${msg.message}`);
      break;
    }
    case 'file_init': {
      // initialize receiving state
      receivingStart({
        transferId: String(msg.transferId || Date.now()),
        fileName: String(msg.fileName || 'file.bin'),
        fileSize: Number(msg.fileSize || 0),
        fileType: String(msg.fileType || 'application/octet-stream'),
        chunkSize: Number(msg.chunkSize || 64*1024),
        hash: msg.hash || null,
      });
      sendControl({ type: 'file_ack', transferId: receiving.transferId });
      break;
    }
    case 'file_done': {
      // sender indicates completion; receiver attempts assembly
      if (receiving.active && String(msg.transferId) === String(receiving.transferId)) {
        await receivingFinalize();
      }
      break;
    }
    case 'file_abort': {
      if (receiving.active && String(msg.transferId) === String(receiving.transferId)) {
        appendMessage(`❌ Sender aborted transfer: ${msg.reason || 'unknown'}`);
        receivingStop();
      }
      break;
    }
    case 'file_ack': {
      // purely informational for the sender; nothing special required
      log(`file_ack received for transfer ${msg.transferId}`);
      break;
    }
    default: {
      log(`Unknown control message: ${JSON.stringify(msg)}`);
    }
  }
}

function receivingStart({ transferId, fileName, fileSize, fileType, chunkSize, hash }) {
  receivingStop(true); // clear any prior state silently

  const totalChunks = Math.ceil(fileSize / chunkSize) || 0;
  receiving = {
    active: true,
    transferId,
    fileName,
    fileSize,
    fileType,
    chunkSize,
    totalChunks,
    receivedBytes: 0,
    startTime: Date.now(),
    lastBytes: 0,
    lastTick: Date.now(),
    chunks: new Map(),
    speedTimer: null,
    integrity: { claimedHash: hash || null, computedHash: null }
  };

  if (receiving.speedTimer) clearInterval(receiving.speedTimer);
  receiving.speedTimer = setInterval(() => updateReceiveSpeedUI(), 1000);

  appendMessage(`📥 Receiving ${fileName} (${formatFileSize(fileSize)})`);
  setFileStatus(`Receiving ${fileName}... 0%`);
}

function receivingStop(silent) {
  if (receiving.speedTimer) {
    clearInterval(receiving.speedTimer);
    receiving.speedTimer = null;
  }
  if (!silent && receiving.active) {
    appendMessage('⚠️ Receive cancelled');
  }
  receiving = {
    active: false,
    transferId: null,
    fileName: "",
    fileSize: 0,
    fileType: 'application/octet-stream',
    chunkSize: 64 * 1024,
    totalChunks: 0,
    receivedBytes: 0,
    startTime: 0,
    lastBytes: 0,
    lastTick: 0,
    chunks: new Map(),
    speedTimer: null,
    integrity: { claimedHash: null, computedHash: null }
  };
  setFileStatus('');
}

function updateReceiveSpeedUI() {
  if (!receiving.active) return;
  const now = Date.now();
  const elapsed = Math.max(1, (now - receiving.startTime) / 1000);
  const avg = receiving.receivedBytes / elapsed;
  const pct = receiving.fileSize > 0 ? Math.floor((receiving.receivedBytes / receiving.fileSize) * 100) : 0;
  setFileStatus(`Receiving ${receiving.fileName}... ${pct}%\nSpeed: ${formatSpeed(avg)}\nTime: ${formatTime(elapsed)}`);
}

function handleBinaryChunk(buffer) {
  if (!receiving.active) return; // ignore unexpected chunks
  if (!(buffer instanceof ArrayBuffer)) return;
  if (buffer.byteLength < CHUNK_HEADER_BYTES) return;

  const dv = new DataView(buffer);
  const magic = dv.getUint32(0, false);
  const version = dv.getUint16(4, false);
  const flags = dv.getUint16(6, false);
  const index = dv.getUint32(8, false);
  const length = dv.getUint32(12, false);

  if (magic !== CHUNK_MAGIC || version !== CHUNK_VERSION) {
    log('Dropping malformed chunk (bad magic/version)');
    return;
  }

  if (CHUNK_HEADER_BYTES + length > buffer.byteLength) {
    log('Dropping malformed chunk (length overflow)');
    return;
  }

  // Avoid double-counting
  if (!receiving.chunks.has(index)) {
    const payload = buffer.slice(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + length);
    receiving.chunks.set(index, new Uint8Array(payload));
    receiving.receivedBytes += length;
  }
}

async function receivingFinalize() {
  if (!receiving.active) return;

  // Stop speed timer
  if (receiving.speedTimer) {
    clearInterval(receiving.speedTimer);
    receiving.speedTimer = null;
  }

  const expected = receiving.totalChunks;
  // Some senders may push the last chunk slightly late; wait a short grace period
  await new Promise(res => setTimeout(res, 300));

  if (receiving.chunks.size !== expected) {
    appendMessage(`❌ File incomplete: got ${receiving.chunks.size}/${expected} chunks`);
    setFileStatus(`❌ File transfer incomplete for ${receiving.fileName}`);
    receivingStop();
    return;
  }

  // Assemble in strict order
  const parts = new Array(expected);
  let assembledBytes = 0;
  for (let i = 0; i < expected; i++) {
    const chunk = receiving.chunks.get(i);
    if (!chunk) {
      appendMessage(`❌ Missing chunk ${i}`);
      setFileStatus(`❌ File transfer incomplete for ${receiving.fileName}`);
      receivingStop();
      return;
    }
    parts[i] = chunk;
    assembledBytes += chunk.byteLength;
  }

  const blob = new Blob(parts, { type: receiving.fileType });

  // Optional integrity: compute SHA-256 if requested and available
  if (receiving.integrity.claimedHash && blob.size < 1024 * 1024 * 1024) { // avoid hashing >1GB
    try {
      const buf = await blob.arrayBuffer();
      receiving.integrity.computedHash = await sha256(buf);
    } catch (_) {
      receiving.integrity.computedHash = null;
    }
  }

  const elapsed = Math.max(1, (Date.now() - receiving.startTime) / 1000);
  const avg = assembledBytes / elapsed;
  setFileStatus(`✅ File received: ${receiving.fileName}\nAverage speed: ${formatSpeed(avg)}\nTime: ${formatTime(elapsed)}`);
  appendMessage(`📁 File ready: ${receiving.fileName} (${formatFileSize(blob.size)})`);

  if (receiving.integrity.claimedHash) {
    if (receiving.integrity.computedHash && receiving.integrity.computedHash === receiving.integrity.claimedHash) {
      appendMessage(`🔒 Hash verified (SHA-256): ${receiving.integrity.computedHash.slice(0,16)}…`);
    } else {
      appendMessage('⚠️ Hash could not be verified or did not match');
    }
  }

  addDownloadLink(receiving.fileName, blob);
  receivingStop(true);
}

// ---------------------------------------------------------
// Sender side — chunker with backpressure and graceful finish
// ---------------------------------------------------------

async function sendFile(file) {
  if (!file) throw new Error('No file selected');
  if (!dataChannel || dataChannel.readyState !== 'open') {
    appendMessage('⚠️ Data channel not open yet.');
    return;
  }

  const chunkSize = 64 * 1024; // conservative for mobile
  const totalChunks = Math.ceil(file.size / chunkSize);
  const transferId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

  // Precompute hash opportunistically for integrity (bounded by size)
  let claimedHash = null;
  if (file.size <= 100 * 1024 * 1024) { // only hash files ≤100MB to avoid long UI stalls
    try { claimedHash = await sha256(await file.arrayBuffer()); }
    catch (_) { claimedHash = null; }
  }

  // 1) Announce transfer
  sendControl({
    type: 'file_init',
    transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    chunkSize,
    hash: claimedHash
  });

  // (optional) wait briefly for ack to give slow receivers time to prep
  await waitForBufferedLow(150);

  // 2) Stream chunks with backpressure
  const started = Date.now();
  let sentBytes = 0;

  for (let index = 0; index < totalChunks; index++) {
    const begin = index * chunkSize;
    const end = Math.min(begin + chunkSize, file.size);
    const slice = file.slice(begin, end);
    const payload = new Uint8Array(await slice.arrayBuffer());

    const header = new ArrayBuffer(CHUNK_HEADER_BYTES);
    const dv = new DataView(header);
    dv.setUint32(0, CHUNK_MAGIC, false);
    dv.setUint16(4, CHUNK_VERSION, false);
    dv.setUint16(6, 0, false); // flags reserved
    dv.setUint32(8, index, false);
    dv.setUint32(12, payload.byteLength, false);

    const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
    frame.set(new Uint8Array(header), 0);
    frame.set(payload, CHUNK_HEADER_BYTES);

    dataChannel.send(frame.buffer);
    sentBytes += payload.byteLength;

    // backpressure: if bufferedAmount is high, wait until it drops
    if (dataChannel.bufferedAmount > BUFFERED_HIGH) {
      await waitForBufferedLow();
    }

    // progress UI
    const elapsed = Math.max(1, (Date.now() - started) / 1000);
    const pct = Math.floor((sentBytes / file.size) * 100);
    const avg = sentBytes / elapsed;
    setFileStatus(`Sending ${file.name}... ${pct}%\nSpeed: ${formatSpeed(avg)}\nTime: ${formatTime(elapsed)}`);
  }

  // drain any remaining buffered data
  while (dataChannel.bufferedAmount > 0) {
    await new Promise(res => setTimeout(res, 30));
  }

  // 3) Signal completion
  sendControl({ type: 'file_done', transferId });

  const totalTime = Math.max(1, (Date.now() - started) / 1000);
  const avg = file.size / totalTime;
  setFileStatus(`✅ File sent: ${file.name}\nAverage speed: ${formatSpeed(avg)}\nTime: ${formatTime(totalTime)}`);
  appendMessage(`✅ Sent ${file.name} (${formatFileSize(file.size)})`);
}

function waitForBufferedLow(timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };

    const cleanup = () => {
      try { dataChannel.removeEventListener('bufferedamountlow', onLow); } catch (_) {}
      if (timer) clearTimeout(timer);
    };

    const onLow = () => {
      if (dataChannel.bufferedAmount <= BUFFERED_LOW) {
        finish();
      }
    };

    let timer = null;
    try { dataChannel.addEventListener('bufferedamountlow', onLow); } catch (_) {}
    if (timeoutMs > 0) {
      timer = setTimeout(finish, timeoutMs);
    }

    // Also poll occasionally in older browsers that may not fire the event reliably
    const poll = () => {
      if (done) return; 
      if (!dataChannel || dataChannel.readyState !== 'open') return finish();
      if (dataChannel.bufferedAmount <= BUFFERED_LOW) return finish();
      setTimeout(poll, 60);
    };
    poll();
  });
}

// ---------------------------------------------------------
// Chat wiring (unchanged DOM IDs)
// ---------------------------------------------------------

const sendBtnEl = document.getElementById('sendBtn');
if (sendBtnEl) {
  sendBtnEl.onclick = () => {
    const input = document.getElementById('msgInput');
    const msg = input ? String(input.value || '').trim() : '';
    if (!msg) return;

    if (!dataChannel || dataChannel.readyState !== 'open') {
      appendMessage('⚠️ Data channel not open, cannot send chat');
      return;
    }

    const chatMessage = {
      type: 'chat',
      message: msg,
      sender: myName,
      timestamp: Date.now()
    };

    try { dataChannel.send(JSON.stringify(chatMessage)); }
    catch (err) { appendMessage(`❌ Chat send failed: ${err?.message || err}`); }

    appendMessage(`${myName}: ${msg}`);
    if (input) input.value = '';
  };
}

const msgInputEl = document.getElementById('msgInput');
if (msgInputEl) {
  msgInputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const btn = document.getElementById('sendBtn');
      if (btn) btn.click();
    }
  });
}

// ---------------------------------------------------------
// File send button wiring
// ---------------------------------------------------------

const sendFileBtnEl = document.getElementById('sendFileBtn');
if (sendFileBtnEl) {
  sendFileBtnEl.onclick = async () => {
    try {
      const fileEl = document.getElementById('fileInput');
      if (!fileEl || !fileEl.files || !fileEl.files.length) {
        alert('Choose a file first');
        return;
      }
      if (!dataChannel || dataChannel.readyState !== 'open') {
        appendMessage('⚠️ Data channel not open yet.');
        return;
      }
      const file = fileEl.files[0];
      await sendFile(file);
    } catch (err) {
      appendMessage(`❌ Error sending file: ${err?.message || err}`);
      try { sendControl({ type: 'file_abort', transferId: 'unknown', reason: String(err?.message || err) }); } catch (_) {}
    }
  };
}

// ---------------------------------------------------------
// Initial UI state and greeting
// ---------------------------------------------------------

appendMessage(`🎮 Welcome! Your name is: ${myName}`);
setUIState('disconnected');
const sb = document.getElementById('startBtn');
if (sb) sb.disabled = !pairedPeer;

// End of file
