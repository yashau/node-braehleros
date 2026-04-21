# node-braehleros

Node.js client for the **BrählerOS** conference management system. Connects to the system's TCP port, receives the full conference state on startup, then streams live events as delegates request to speak, are granted the floor, or are removed.

Zero dependencies. Pure Node.js built-ins only (`net`, `events`, `crypto`).

## Install

```bash
npm install node-braehleros
```

## Quick start

```js
const { BraehlerClient } = require('node-braehleros');

const ac = new AbortController();
const client = new BraehlerClient({ host: '192.168.1.100' });

client.on('ready', (state) => {
  console.log('Requests:', state.requests);
  console.log('Delegates:', state.delegates);
});

client.on('speaker:added',   (e) => console.log('Now speaking:', e.delegate?.first, e.delegate?.last));
client.on('speaker:removed', (e) => console.log('Done speaking:', e.seat));
client.on('request:added',   (e) => console.log('Request #' + (e.position + 1), e.delegate?.last));
client.on('request:removed', (e) => console.log('Request withdrawn:', e.seat));

client.connect(ac.signal);

// Disconnect cleanly
// ac.abort();
```

## API

### `new BraehlerClient(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | string | **required** | IP address or hostname of the BrählerOS server |
| `port` | number | `400` | TCP port (`ConfClientServicePort`) |
| `connectTimeout` | number | `10000` | ms before TCP connection attempt is abandoned |
| `handshakeTimeout` | number | `30000` | ms from connect to receiving full initial state |
| `reconnect` | boolean | `true` | Automatically reconnect on disconnect |
| `reconnectBaseDelay` | number | `1000` | Initial reconnect delay in ms |
| `reconnectMaxDelay` | number | `30000` | Maximum reconnect delay in ms |
| `reconnectBackoff` | number | `1.5` | Exponential backoff multiplier |

### `client.connect([signal])` → `this`

Opens the connection. Pass an `AbortSignal` to control the lifetime of the client — aborting permanently disconnects and stops all reconnect attempts.

```js
const ac = new AbortController();
client.connect(ac.signal);

// later:
ac.abort(); // clean disconnect, no more reconnects
```

### `client.disconnect()`

Equivalent to aborting the signal passed to `connect()`.

### `client.getState()` → `object`

Returns a full JSON-serialisable snapshot of the current state.

```js
{
  conference:    { id: 16, state: 4 } | null,
  speakers:      [ /* Entry[] */ ],
  requests:      [ /* Entry[], ordered by queue position */ ],
  interventions: [ /* Entry[] */ ],
  delegates:     { [seat]: Delegate },  // all known seat→delegate mappings
  ready:         true
}
```

### `client.getSpeakers()` → `Entry[]`
### `client.getRequests()` → `Entry[]`
### `client.getInterventions()` → `Entry[]`

Return copies of the respective live lists.

### `client.getDelegates()` → `{ [seat]: Delegate }`

All seat→delegate mappings loaded from the server. Keys are seat numbers (integers as strings when JSON-serialised).

### `client.getDelegate(seatNum)` → `Delegate | null`

Look up the delegate assigned to a specific seat number.

### `client.isReady()` → `boolean`

`true` once the initial state has been fully received.

---

## Events

### Lifecycle

| Event | Payload | Description |
|---|---|---|
| `connected` | — | TCP connection established |
| `licensed` | `{ version }` | Server accepted the connection; `version` is the server version string |
| `disconnected` | — | Socket closed |
| `reconnecting` | `{ attempt, delay }` | About to reconnect; `delay` is the wait in ms |
| `error` | `Error` | Socket or protocol error |
| `parse-error` | `{ cmd, len, err }` | A packet could not be parsed (connection stays open) |

### State

| Event | Payload | Description |
|---|---|---|
| `ready` | `state` (full snapshot) | Initial state fully loaded; same object as `getState()` |
| `conference:state` | `{ id, state }` | Conference state update from the server |

### Speaker list

| Event | Payload |
|---|---|
| `speaker:added` | `Entry` |
| `speaker:removed` | `Entry` |

### Request queue

| Event | Payload |
|---|---|
| `request:added` | `Entry` |
| `request:removed` | `Entry` |

### Intervention list

| Event | Payload |
|---|---|
| `intervention:added` | `Entry` |
| `intervention:removed` | `Entry` |

---

## Data shapes

### Entry

```js
{
  seat:     97,          // conference seat number
  position: 0,           // 0-based position in the list
  delegate: Delegate | null
}
```

### Delegate

```js
{
  id:    101839,
  first: 'Jane',
  last:  'Doe',
  org:   'Example Org'
}
```

---

## Reconnect behaviour

The client uses exponential backoff between reconnect attempts:

```
attempt 1 →  1.0s
attempt 2 →  1.5s
attempt 3 →  2.25s
...
attempt N →  min(baseDelay × backoff^N, maxDelay)
```

A successful connection resets the attempt counter. If the server explicitly denies the license, reconnect is disabled automatically.

---

## Requirements

- Node.js ≥ 14
- Network access to the BrählerOS server on port 400
