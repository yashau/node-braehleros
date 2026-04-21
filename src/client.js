'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { randomBytes } = require('crypto');
const Parser = require('./parser');
const { CMD, CLIENT_TYPE } = require('./protocol');

function newGuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

const DEFAULTS = {
  port:                400,
  connectTimeout:    10_000,  // ms — TCP connection establishment
  handshakeTimeout:  30_000,  // ms — connect → EndInitialize
  reconnect:          true,
  reconnectBaseDelay: 1_000,
  reconnectMaxDelay: 30_000,
  reconnectBackoff:    1.5,
};

class BraehlerClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}  options.host
   * @param {number}  [options.port=400]
   * @param {number}  [options.connectTimeout=10000]
   * @param {number}  [options.handshakeTimeout=30000]
   * @param {boolean} [options.reconnect=true]
   * @param {number}  [options.reconnectBaseDelay=1000]
   * @param {number}  [options.reconnectMaxDelay=30000]
   * @param {number}  [options.reconnectBackoff=1.5]
   */
  constructor(options = {}) {
    super();
    if (!options.host) throw new Error('options.host is required');
    this._opts = { ...DEFAULTS, ...options };

    this._socket           = null;
    this._incoming         = Buffer.alloc(0);
    this._sendQueue        = [];
    this._sending          = false;

    this._initialized      = false;
    this._aborted          = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer   = null;
    this._handshakeTimer   = null;

    // name-resolution tables — populated from Initialize packet
    this._ddMap   = new Map(); // DelegateDataID → { id, first, last, org }
    this._delMap  = new Map(); // DelegateID     → DelegateDataID
    this._seatMap = new Map(); // seatNumber     → DelegateID

    // live state
    this._conference    = null;
    this._speakers      = [];
    this._requests      = [];
    this._interventions = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Open the connection.
   * @param {AbortSignal} [signal] — abort to permanently disconnect and stop reconnecting
   */
  connect(signal) {
    if (signal?.aborted) return this;
    signal?.addEventListener('abort', () => this._abort(), { once: true });
    this._doConnect();
    return this;
  }

  /** Permanently disconnect. Equivalent to aborting the signal. */
  disconnect() { this._abort(); }

  /** Full snapshot of all current state. Safe to JSON.stringify. */
  getState() {
    return {
      conference:    this._conference ? { ...this._conference } : null,
      speakers:      this.getSpeakers(),
      requests:      this.getRequests(),
      interventions: this.getInterventions(),
      delegates:     this.getDelegates(),
      ready:         this._initialized,
    };
  }

  /** Currently active speakers, ordered by position. */
  getSpeakers() { return this._speakers.map(cloneEntry); }

  /** Request queue, ordered by position (0 = next to speak). */
  getRequests() { return this._requests.map(cloneEntry); }

  /** Intervention list, ordered by position. */
  getInterventions() { return this._interventions.map(cloneEntry); }

  /**
   * All known seat→delegate mappings as a plain object (JSON-safe).
   * @returns {{ [seat: number]: object }}
   */
  getDelegates() {
    const out = {};
    for (const [seatNum, did] of this._seatMap) {
      const del = this._resolveDelegate(did);
      if (del) out[seatNum] = del;
    }
    return out;
  }

  /** Returns the delegate assigned to a seat, or null. */
  getDelegate(seatNum) {
    const did = this._seatMap.get(seatNum);
    return did !== undefined ? this._resolveDelegate(did) : null;
  }

  isReady() { return this._initialized; }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  _abort() {
    this._aborted = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._handshakeTimer);
    this._socket?.destroy();
    this._socket = null;
  }

  _doConnect() {
    if (this._aborted) return;
    this._resetState();

    const socket = net.createConnection({
      host: this._opts.host,
      port: this._opts.port,
    });

    // TCP connection timeout — cleared on connect
    socket.setTimeout(this._opts.connectTimeout);
    socket.once('timeout', () => {
      socket.destroy(new Error(`TCP connection timed out after ${this._opts.connectTimeout}ms`));
    });

    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.setKeepAlive(true, 15_000);
      this._socket = socket;
      this._reconnectAttempt = 0;
      this.emit('connected');
      this._startHandshakeTimer();
      this._sendIdentification();
    });

    socket.on('data', (chunk) => {
      this._incoming = Buffer.concat([this._incoming, chunk]);
      this._drain();
    });

    socket.on('error', (err) => {
      this.emit('error', err);
    });

    socket.on('close', () => {
      clearTimeout(this._handshakeTimer);
      this._socket = null;
      this.emit('disconnected');
      if (!this._aborted && this._opts.reconnect) {
        this._scheduleReconnect();
      }
    });
  }

  _startHandshakeTimer() {
    clearTimeout(this._handshakeTimer);
    this._handshakeTimer = setTimeout(() => {
      this._socket?.destroy(new Error(`Handshake timed out after ${this._opts.handshakeTimeout}ms`));
    }, this._opts.handshakeTimeout);
  }

  _scheduleReconnect() {
    const delay = Math.min(
      this._opts.reconnectBaseDelay * (this._opts.reconnectBackoff ** this._reconnectAttempt),
      this._opts.reconnectMaxDelay,
    );
    this._reconnectAttempt++;
    this.emit('reconnecting', { attempt: this._reconnectAttempt, delay });
    this._reconnectTimer = setTimeout(() => this._doConnect(), delay);
  }

  _resetState() {
    this._incoming    = Buffer.alloc(0);
    this._sendQueue   = [];
    this._sending     = false;
    this._initialized = false;
    this._ddMap.clear();
    this._delMap.clear();
    this._seatMap.clear();
    this._conference    = null;
    this._speakers      = [];
    this._requests      = [];
    this._interventions = [];
  }

  // ── Send queue ─────────────────────────────────────────────────────────────

  _enqueue(cmd, payload = Buffer.alloc(0)) {
    this._sendQueue.push({ cmd, payload });
    this._flushQueue();
  }

  _flushQueue() {
    if (this._sending || !this._socket || this._sendQueue.length === 0) return;
    const { cmd, payload } = this._sendQueue.shift();
    const hdr = Buffer.alloc(8);
    hdr.writeInt32LE(cmd, 0);
    hdr.writeInt32LE(payload.length, 4);
    this._sending = true;
    this._socket.write(Buffer.concat([hdr, payload]), () => {
      this._sending = false;
      this._flushQueue();
    });
  }

  _sendIdentification() {
    const guid    = newGuid();
    const guidBuf = Buffer.from(guid, 'utf16le');
    const payload = Buffer.alloc(4 + guidBuf.length + 4);
    let off = 0;
    payload.writeInt32LE(guid.length, off); off += 4;
    guidBuf.copy(payload, off);             off += guidBuf.length;
    payload.writeInt32LE(CLIENT_TYPE.CLIENT, off);
    this._enqueue(CMD.CLIENT_IDENTIFICATION, payload);
  }

  // ── Packet framing ─────────────────────────────────────────────────────────

  _drain() {
    while (this._incoming.length >= 8) {
      const cmd = this._incoming.readInt32LE(0);
      const len = this._incoming.readInt32LE(4);
      if (len < 0 || this._incoming.length < 8 + len) break;
      const payload = this._incoming.slice(8, 8 + len);
      this._incoming = this._incoming.slice(8 + len);
      try {
        this._handlePacket(cmd, payload);
      } catch (err) {
        this.emit('parse-error', { cmd, len, err });
      }
    }
  }

  // ── Packet dispatch ────────────────────────────────────────────────────────

  _handlePacket(cmd, payload) {
    switch (cmd) {
      case CMD.CLIENT_IDENTIFICATION: return this._onIdentAck(payload);
      case CMD.CONFERENCE_STATE:      return this._onConferenceState(payload);
      case CMD.BEGIN_INITIALIZE:      return;
      case CMD.INITIALIZE:            return this._onInitialize(payload);
      case CMD.END_INITIALIZE:        return this._onEndInitialize();
      case CMD.SPEAKER_ADDED:         return this._onAdd(payload, 'speaker');
      case CMD.SPEAKER_REMOVED:       return this._onRemove(payload, 'speaker');
      case CMD.REQUEST_ADDED:         return this._onAdd(payload, 'request');
      case CMD.REQUEST_REMOVED:       return this._onRemove(payload, 'request');
      case CMD.INTERVENTION_ADDED:    return this._onAdd(payload, 'intervention');
      case CMD.INTERVENTION_REMOVED:  return this._onRemove(payload, 'intervention');
      // PREV_SPEAKER_ADDED / REMOVED: intentionally ignored
    }
  }

  _onIdentAck(payload) {
    const p     = new Parser(payload);
    const state = p.readInt32();
    const ver   = p.readString();
    if (state !== 1) {
      this._aborted = true; // server explicitly denied — do not reconnect
      this.emit('error', new Error(`License denied by server (state=${state})`));
      this._socket?.destroy();
      return;
    }
    this.emit('licensed', { version: ver });
  }

  _onConferenceState(payload) {
    const p = new Parser(payload);
    this._conference = { id: Number(p.readInt64()), state: p.readInt32() };
    this.emit('conference:state', { ...this._conference });
  }

  _onEndInitialize() {
    clearTimeout(this._handshakeTimer);
    this._initialized = true;
    this.emit('ready', this.getState());
  }

  // ── Initialize packet ──────────────────────────────────────────────────────

  _onInitialize(payload) {
    const p = new Parser(payload);
    p.skipInt(); // legacy count header

    for (let t = 0; t < 9; t++) {
      const name  = p.readString();
      const count = p.readInt32();
      for (let r = 0; r < count; r++) {
        if      (name === 'DelegateData')              this._parseDelegateData(p);
        else if (name === 'Delegates')                 this._parseDelegates(p);
        else if (name === 'ConferenceDelegateSeatMap') this._parseCDSMap(p);
        else                                           this._skipTableRow(name, p);
      }
    }
  }

  _parseDelegateData(p) {
    p.skipHeader();
    const id    = Number(p.readInt64());
    const last  = p.readString();
    const first = p.readString();
    p.skipString(3);  // MiddleName, Title, EMailAddress
    const org   = p.readString();
    p.skipLong();     // DefaultCardID
    p.skipString(3);  // DefaultPassword, Image, Telephone
    p.skipLong();     // Birthday
    p.skipString(8);  // DelegateInformation…UserID
    p.skipInt();      // Flags
    p.skipString();   // DDParameter
    p.skipInt();      // FingerprintID
    this._ddMap.set(id, { id, first, last, org });
  }

  _parseDelegates(p) {
    p.skipHeader();
    const did  = Number(p.readInt64());
    const ddid = Number(p.readInt64());
    p.skipLong();     // ConferenceID
    p.skipInt(2);     // SpeakTimeLimit, SpeakTimeInterval
    p.skipString(2);  // Weighting, Attendance
    p.skipLong();     // CardID
    p.skipString(3);  // Password, Flags, Customfield
    this._delMap.set(did, ddid);
  }

  _parseCDSMap(p) {
    p.skipHeader();
    p.skipLong(2);
    const did = Number(p.readInt64()); // DelegateID
    const sn  = Number(p.readInt64()); // plain seat number
    if (sn !== 0) this._seatMap.set(sn, did);
  }

  _skipTableRow(name, p) {
    p.skipHeader();
    switch (name) {
      case 'Conference':
        p.skipLong(2); p.skipString(); p.skipLong(2); p.skipString(3);
        p.skipInt(2);  p.skipLong(4);  p.skipInt();   p.skipString(); p.skipInt();
        p.skipString(); p.skipInt(2);  p.skipString(); p.skipLong(2); p.skipString(); p.skipInt();
        break;
      case 'Seats':
        p.skipLong(3); p.skipInt(); p.skipLong(); p.skipInt(2); p.skipLong(); p.skipString(); p.skipLong();
        break;
      case 'AgendaItem':
        p.skipLong(2); p.skipString(2); p.skipInt();  p.skipLong(4);
        p.skipInt();   p.skipString();  p.skipLong(); p.skipString(4); p.skipInt();
        break;
      case 'DelAgendaItem':
      case 'DocAgendaItem':
        p.skipLong(4);
        break;
      case 'Documents':
        p.skipLong(2); p.skipString(); p.skipLong(); p.skipString(); p.skipInt(2); p.skipString(2);
        break;
    }
  }

  // ── Speaker / request / intervention events ────────────────────────────────

  _resolveDelegate(did) {
    const ddid = this._delMap.get(did);
    return ddid !== undefined ? (this._ddMap.get(ddid) ?? null) : null;
  }

  _buildEntry(seatNum, position) {
    const did = this._seatMap.get(seatNum);
    return {
      seat:     seatNum,
      position,
      delegate: did !== undefined ? this._resolveDelegate(did) : null,
    };
  }

  _listFor(type) {
    if (type === 'speaker')      return this._speakers;
    if (type === 'request')      return this._requests;
    if (type === 'intervention') return this._interventions;
  }

  _onAdd(payload, type) {
    const p    = new Parser(payload);
    const list = this._listFor(type);

    if (!this._initialized) {
      // Bulk initial state: [Int32 count][ seatPlain, dcen, pos(-1), state, flags ]
      const count = p.readInt32();
      for (let i = 0; i < count; i++) {
        const seatNum = Number(p.readInt64());
        p.skipLong();  // DCEN hardware unit — not part of the data model
        p.skipInt(3);  // pos (always -1 in bulk), state, flags
        const entry = this._buildEntry(seatNum, i);
        list.push(entry);
        this.emit(`${type}:added`, cloneEntry(entry));
      }
    } else {
      // Live: seatId = (seatNum << 32) | lineNum
      const seatRaw = p.readInt64();
      p.skipLong();    // DCEN unit
      const pos     = p.readInt32();
      p.skipInt(2);    // state, flags
      const seatNum = Number(seatRaw >> 32n);
      const entry   = this._buildEntry(seatNum, pos);
      list.splice(Math.min(pos, list.length), 0, entry);
      list.forEach((e, i) => { e.position = i; });
      this.emit(`${type}:added`, cloneEntry(entry));
    }
  }

  _onRemove(payload, type) {
    const p       = new Parser(payload);
    const list    = this._listFor(type);
    const seatRaw = p.readInt64();
    const seatNum = Number(seatRaw >> 32n);
    const idx     = list.findIndex(e => e.seat === seatNum);
    const entry   = idx !== -1 ? list.splice(idx, 1)[0] : this._buildEntry(seatNum, -1);
    list.forEach((e, i) => { e.position = i; });
    this.emit(`${type}:removed`, cloneEntry(entry));
  }
}

function cloneEntry(e) {
  return { ...e, delegate: e.delegate ? { ...e.delegate } : null };
}

module.exports = { BraehlerClient };
