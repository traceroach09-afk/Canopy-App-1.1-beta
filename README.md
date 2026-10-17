[README.md](https://github.com/user-attachments/files/33610652/README.md)
# Canopy community chat

An account-based, real-time chat prototype with Node.js, WebSockets, SQLite, and a mediasoup WebRTC SFU.

## Run locally

Use Node.js 22 or newer.

```powershell
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000), create an account, then create a public server or join one from Explore. Accounts, server memberships, and chat messages are saved in `yapper.sqlite`. The built-in Canopy Commons server is public; its member list contains only accounts that joined it. Presence reflects signed-in WebSocket connections. There are no seeded users or bot accounts.

Image uploads and Tenor GIFs are stored in the selected community and sent as ordinary chat messages. Community emoji and standard emoji are available from the composer. Tenor search requires an existing Tenor API key; Tenor's official quickstart says it stopped accepting new API clients in January 2026. In PowerShell, set the key in the same session before starting Canopy:

```powershell
$env:TENOR_API_KEY = 'YOUR_EXISTING_TENOR_API_KEY'
npm start
```

The key stays on the server and is never sent to browsers. Without it, image uploads and emoji still work, and the GIF picker reports that Tenor search needs configuration.

## Architecture

- The Node HTTP server serves the app and account/community API.
- `ws` carries authenticated room membership, presence, chat messages, and mediasoup signaling requests.
- SQLite stores password hashes (scrypt), expiring session-token hashes, public servers, memberships, and per-channel message history.
- mediasoup creates one Router per active server/channel room. Each calling browser has separate send and receive WebRTC transports; the SFU forwards produced audio/video to consumers in that room.
- The browser's mediasoup-client Device negotiates router capabilities, creates transports, produces local microphone/camera tracks, and consumes remote tracks.

## Allow remote clients

The default SFU bind is loopback for local development. For a host reachable by other devices, set the SFU's bind and public address before starting it. Example PowerShell session:

```powershell
$env:MEDIASOUP_LISTEN_IP = '0.0.0.0'
$env:MEDIASOUP_ANNOUNCED_ADDRESS = 'YOUR_PUBLIC_IP_OR_DNS_NAME'
npm start
```

Route TCP port 3000 through an HTTPS reverse proxy and allow the mediasoup UDP/TCP range 40000–40100 through the host firewall and NAT. Users should access the site through HTTPS so browser media permissions work; WebSocket signaling will then use WSS. Networks that block direct UDP may also need a TURN service, which this prototype does not configure.

This is a development prototype. Before opening it to the public, add email verification, account recovery, rate limiting, stronger abuse controls, origin validation, a production TLS/session-secret deployment, backups, and a TURN configuration.
