# Math Duel — Multiplayer Edition

A Node.js + Socket.IO version of Math Duel. One device (a TV or laptop) hosts the
game arena; up to two players join from their phones and play using an on-screen
joystick.

## Setup

```
npm install
npm start
```

The server runs on port 3000 by default (set `PORT=xxxx` to change it).

## Playing

1. On the TV/PC, open `http://<your-computer's-LAN-IP>:3000` and choose **CREATE GAME**.
   A 6-digit room code appears on screen.
2. On each phone (connected to the same Wi‑Fi/network), open the same address and
   choose **JOIN GAME**, then type in the room code.
3. Each phone is assigned Player A or Player B. Once both phones are connected,
   tap **READY UP** on each.
4. Once both players are ready, the host picks a difficulty and presses
   **START DUEL**. The joystick appears on both phones.
5. The left side of each phone's joystick (the D-pad) picks the tile with the
   correct answer — up / down / left / right. The big button on the right is
   reserved for future games and currently does nothing but light up blue when
   pressed.

## Project layout

- `server.js` — Express + Socket.IO server. Manages rooms, player slots (A/B),
  the ready-up lobby, and relays each phone's button presses to the host.
- `public/index.html` — Landing page: Create Game / Join Game.
- `public/host.html` — The game arena (the Math Duel board), shown on the
  hosting device. Listens for `ctrl_input` events from the server instead of
  local keyboard input.
- `public/controller.html` — The phone controller UI (room code entry, ready-up
  lobby, joystick).

## Notes

- Everything needed to play — including sound effects and music — is bundled
  directly into `host.html`, so the whole `public/` folder is self-contained.
- If a phone's connection drops mid-match, it auto-reconnects and is re-bound
  to its original slot.
