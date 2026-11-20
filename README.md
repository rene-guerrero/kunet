# kunet

Multiplayer plumbing shared by the Ku table games (Kudominoes, KuCards). Each game keeps its own protocol
and room logic (`RoomCore`); kunet carries JSON frames between players and that room wherever it runs.

- `LocalRoom` / `LocalHost` — host a game's `RoomCore` in this process (phone WebView, Node, a browser
  tab): links are its sockets, one `setTimeout` is its alarm (like the Durable Object's).
- `loopbackBackend(host)` — the hosting device's own player, as an in-memory socket pair.
- `kunet/node` → `serveLan()` — the PC dev host: serves a game's `dist/` and the Worker's room routes
  (`POST /api/rooms`, `GET /api/rooms/:code`, `GET /api/rooms/:code/ws`) on the local network.
- `localServed(game)` / `joinOrigin()` — a page served by a local host knows it (the host injects
  `window.__KUNET_LOCAL__`) and talks to its own origin.
- `qrSvg(text)` — inline SVG QR codes for join links.

Consumed from GitHub tags, like kuavatars: `"kunet": "github:rene-guerrero/kunet#vX.Y.Z"`.

Planned: the client connection (`RoomClient`), the Worker + Durable Object adapter, the dev mock hub, and
the Android plugin (Wi-Fi host, then Nearby Connections).

```
npm test
npm run typecheck
```
