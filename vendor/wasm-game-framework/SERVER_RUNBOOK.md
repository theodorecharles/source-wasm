# Dedicated server lifecycle runbook

This is the implementation and acceptance contract for a browser game that
starts a native dedicated server on demand and stops it while idle. The web
server, launcher, provisioning API, and WebSocket proxy remain available; the
idle policy controls the expensive game-server process.

Use this with [ADAPTER_RUNBOOK.md](ADAPTER_RUNBOOK.md). The adapter runbook owns
browser/engine state. This runbook owns the separate server process, readiness,
population, transport, bots, and recovery.

For deployments that also expose a variable private media collection, use the
framework 0.9 media-library routes rather than adding title-specific upload
endpoints. `POST /game-data/media/uploads` creates a bounded session, each
declared file is sent to its opaque upload-file route, and `POST .../commit`
validates and atomically publishes the whole bundle. Mutations use the existing
setup-token and password boundaries. Public lists contain opaque IDs, labels,
counts, sizes, timestamps, and explicitly allowlisted scalar metadata—never
host paths or raw filenames. Entry details and immutable range-capable file
routes remain password-gated with the rest of `/game-data`.

## 1. Define the process boundary

Keep these responsibilities separate:

```text
framework Play
  -> POST /wake
  -> lifecycle supervisor
  -> native dedicated server on a random rotation map
  -> readiness probe
  -> browser engine starts/connects
  -> fully admitted human count drives idle policy
```

The HTTP application and WebSocket-to-game transport proxy stay up while the
dedicated server sleeps. Do not exit the Docker container merely because the
native game process stopped. A later request must still be able to load the
launcher and wake the game.

Do not start a server because somebody fetched the page, opened `/ws`, or
probed a health endpoint. Only an explicit framework Play/reconnect action may
wake it. This avoids background tabs, crawlers, and failed sockets consuming a
server allocation.

## 2. Expose a small same-origin API

Provide exactly these public lifecycle operations:

| Route | Method | Purpose |
| --- | --- | --- |
| `/status` | `GET` | Return current lifecycle state and public match metadata |
| `/wake` | `POST` | Idempotently start the server or join the pending start |
| `/wake` | `GET` | Reject with `405` |
| `/ws` | WebSocket upgrade | Proxy game packets; never wake the server by itself |

Use the supervisor states `sleeping`, `starting`, `running`, `stopping`, and
`failed`. A status response should include at least:

```json
{
  "state": "running",
  "map": "q3dm11",
  "humans": 1,
  "bots": 7,
  "keepAlive": false,
  "idleTimeoutMs": 300000,
  "idleSince": null,
  "startedAt": 1786750000000,
  "error": null
}
```

Do not expose process arguments, filesystem paths, secrets, remote addresses,
or raw internal exceptions. Limit the wake request body, require JSON, enforce
a same-origin `Origin` when browsers supply one, and rate-limit repeated failed
wakes. A wake is idempotent, but it should not become a public process-spawn
primitive.

When `WASM_GAME_PASSWORD` is set, create one framework password gate and use it
for the static/data server, `/wake`, and WebSocket upgrades:

```js
const { createPasswordGate } =
  require('@wasm-game-framework/browser/server/password-auth');

const passwordGate = createPasswordGate();

if (await passwordGate.handle(request, response, url)) return;
if (url.pathname === '/wake' && !passwordGate.require(request, response)) return;

webSocketServer.on('connection', (socket, request) => {
  if (!passwordGate.authenticated(request)) return socket.close(1008, 'Password required');
  attachGameTransport(socket);
});
```

Authenticate the HTTP upgrade request before calling `handleUpgrade()` when the
WebSocket library permits it, so an unauthorized peer never becomes a live game
socket. Do not send the password in a WebSocket subprotocol, query string,
native game command, or game-server log. The canonical browser uses
`/auth/status`, `/auth/login`, and an HttpOnly session cookie.

## 3. Connect `IdleServiceSupervisor`

The framework server package exports the reusable state machine:

```js
const {
  IdleServiceSupervisor,
  environmentOptions
} = require('@wasm-game-framework/browser/server/lifecycle');

const lifecycle = new IdleServiceSupervisor({
  ...environmentOptions(process.env),
  maps: rotation,
  start: async ({ map }) => startDedicatedServer({ map }),
  waitUntilReady: async handle => waitForNativeReady(handle),
  stop: async (handle, reason) => stopDedicatedServer(handle, reason),
  onStatus: status => publishStatus(status)
});
```

`start()` must resolve to an opaque process handle. `waitUntilReady()` must
prove that the native server is accepting game traffic, not merely that a child
PID exists. `stop()` should request graceful native shutdown, wait for exit,
then use a bounded forced termination only if the process ignores the request.

Pass a reviewed, non-empty map rotation. The supervisor chooses a fresh random
entry for each cold wake. Validate map names against that rotation before they
reach a command line or console string.

Concurrent `/wake` requests must share one `lifecycle.wake()` promise. Never
spawn two native servers because two players pressed Play together. Likewise,
serialize stop and wake so a reconnect arriving during shutdown waits for the
old process to exit before starting the replacement.

## 4. Wake from framework Play

Create one browser wake client in the downstream adapter:

```js
const wake = WasmGameFramework.createWakeClient({
  statusUrl: '/status',
  wakeUrl: '/wake',
  interval: 500,
  timeout: 45000,
  onStatus(status) {
    context.shell.setLoadingDetail(serverStatusText(status));
  }
});

async function start(context) {
  context.shell.setEngineState('loading');
  await wake.ensureRunning({ reason: 'play' });
  await startBrowserEngineAndConnect();
}
```

The framework switches to its loading surface as soon as Play is clicked.
Show `starting`, readiness, connection, challenge, and map-loading progress on
that surface. Do not leave the launcher visible while the server boots.

Wake before presenting a native multiplayer menu when the product contract is
an immediately available hosted match. A native JOIN/reconnect action should
call the same idempotent wake path again if the process could have slept while
the browser remained open. It must not implement a second supervisor.

The browser engine connects only after `/status` reports `running` or `ready`.
On timeout or `failed`, report `crashed`/recoverable failure through the
adapter, release input, and allow a deliberate retry without reloading the
page.

## 5. Count humans correctly

Call `lifecycle.observeHumans(count)` from authoritative native server state.
A human counts after the connection has been admitted far enough that the
server owns a real client slot. Count human spectators as connected humans so
an active spectator session cannot be shut down underneath them.

Exclude:

- bots/test clients;
- challenge-only or connecting slots;
- zombie/disconnecting slots;
- stale proxy sockets with no admitted native client;
- the local server console.

Update promptly on admission, disconnect, timeout, and process exit. Do not
derive human population from browser tabs, WebSocket count, IP addresses, team
membership, or the number of scoreboard rows.

When the count changes from positive to zero, the idle deadline begins. A new
human cancels the timer immediately. Repeated zero observations do not reset
the deadline and keep an empty server alive forever.

## 6. Fill bots around humans

Bot policy belongs to the game/server integration, not the generic framework.
Implement a target total population:

```text
desired bots = max(0, player target - admitted humans)
```

Add or remove bots until the server converges on that value. Prefer removing a
bot before admitting a human when all slots are occupied. Otherwise configure
headroom: for an eight-player match, use at least nine native slots, or a larger
administrator-selected maximum, so a human is never rejected before the bot
fill loop runs.

The idle supervisor receives only the human count. Bots never prevent shutdown.
After a cold wake the server may fill bots immediately, but the random map must
finish loading before browser clients are told the server is ready.

## 7. Configure Docker behavior

Use these common environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `KEEP_ALIVE` | `false` | Keep the native dedicated server running indefinitely |
| `IDLE_TIMEOUT` | `5m` | Empty-human duration before native shutdown (`ms`, `s`, `m`, `h`) |
| `WASM_GAME_PASSWORD` | empty | Optional password required before adapter/data/wake/WebSocket access |
| `WASM_GAME_PASSWORD_TTL` | `12h` | Password-session lifetime |
| `WASM_GAME_TRUST_PROXY` | `false` | Trust `X-Forwarded-Proto` from a controlled TLS proxy for secure cookies |
| game-specific slots variable | game policy | Native maximum client slots, including bot/headroom policy |
| game-specific bot variable | game policy | Desired total match population or bot enablement |
| game-specific rotation variable | built-in rotation | Reviewed map rotation used for random cold starts |

Mount game data and server configuration under persistent `/data`; keep the
native process working directory in a separate runtime directory. Do not put
game archives in the image. Bind the HTTP/WebSocket port continuously and the
native UDP port only when that title supports direct native clients.

`KEEP_ALIVE=true` disables idle stopping but does not bypass readiness checks
or failure recovery. `IDLE_TIMEOUT=0` means stop as soon as the last admitted
human leaves; tests must cover that explicitly if a game exposes it.

## 8. Recover without wedging the container

Watch the native child. An unexpected exit changes lifecycle state to `failed`
or `sleeping` according to downstream policy and clears the process handle,
population, map, and timers. A later explicit wake must be able to start a new
child.

Handle these races deliberately:

- simultaneous wake requests;
- wake while stopping;
- stop while starting;
- process exit during readiness polling;
- last human leaving while a new admission is in progress;
- stale browser reconnect after idle shutdown;
- container `SIGTERM` during a running match.

On container shutdown, stop accepting new wakes, close the proxy, request a
graceful native shutdown, and exit within the orchestrator's termination
window. Never leave an orphaned dedicated process.

## 9. Required acceptance pass

Prove the complete lifecycle with the production image:

1. Container starts with the HTTP app ready and native server sleeping.
2. Loading the page, polling `/status`, and opening `/ws` do not wake it.
3. Framework Play paints loading immediately and sends one `POST /wake`.
4. Two simultaneous wakes start exactly one native process.
5. Cold wake selects a map from the rotation and waits for real readiness.
6. Browser client connects and becomes an admitted human.
7. Bots converge to the configured total and drop as humans join.
8. A human spectator prevents idle shutdown; bots alone do not.
9. Last-human disconnect starts one stable idle deadline.
10. Rejoining before the deadline cancels shutdown.
11. Remaining empty past the deadline stops only the native server.
12. A new Play/reconnect wakes a fresh process on another eligible random map.
13. `KEEP_ALIVE=true` survives beyond the timeout with zero humans.
14. Startup failure appears in `/status` and the browser can retry successfully.
15. `GET /wake` is `405`; `/data` and `/local-data` are `404`; no secret or
    filesystem path appears in status/errors.
16. With `WASM_GAME_PASSWORD` set, wrong/missing passwords cannot fetch game
    data, wake the server, or upgrade `/ws`; a valid HttpOnly session can.
17. Container `SIGTERM` leaves no native child or listening game socket.

Record timestamps, selected maps, child PID counts, native readiness evidence,
human/bot counts, and HTTP status codes. A mocked supervisor unit test is not a
substitute for one real native-process/image pass.

## 10. Common failure signatures

- **Server wakes on page view:** wake was tied to module load, health polling,
  or WebSocket upgrade instead of framework Play.
- **Delay before loading appears:** adapter awaited `/wake` before reporting
  `loading`.
- **Two servers start:** `/wake` bypassed the supervisor's shared pending
  promise.
- **Empty server never sleeps:** bots or connecting/zombie slots were counted
  as humans, or repeated zero observations reset `idleSince`.
- **Spectator gets disconnected by idle stop:** population counted team players
  rather than admitted human clients.
- **Human cannot join an eight-bot match:** native max slots equals bot target
  without headroom or pre-admission bot eviction.
- **Reconnect hits a dead UDP target:** the proxy did not reread lifecycle state
  after idle shutdown, or JOIN did not reuse the wake client.
- **Container exits when idle:** the lifecycle boundary stopped PID 1 instead of
  only the native dedicated process.
