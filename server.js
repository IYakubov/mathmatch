const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});
app.get('/controller', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'controller.html'));
});

// Generates a QR code (SVG) that points to the join link for a room code.
// Uses the Host header the browser actually connected with, so it works
// correctly whether the host page was opened via localhost or a LAN IP —
// whatever address the TV/PC is reachable at is what gets encoded.
app.get('/qr/:code', async (req, res) => {
  const code = req.params.code;
  if (!/^\d{6}$/.test(code)) {
    res.status(400).send('invalid code');
    return;
  }
  const joinUrl = `${req.protocol}://${req.get('host')}/controller?code=${code}`;
  try {
    const svg = await QRCode.toString(joinUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: '#2e2a4a', light: '#ffffff' }
    });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).send('qr generation failed');
  }
});

// Returns the plain join URL as text, so the host page can display it
// next to the QR code without duplicating the host-detection logic.
app.get('/join-url/:code', (req, res) => {
  const code = req.params.code;
  if (!/^\d{6}$/.test(code)) {
    res.status(400).send('invalid code');
    return;
  }
  res.type('text/plain').send(`${req.protocol}://${req.get('host')}/controller?code=${code}`);
});

// In-memory room state.
// rooms[code] = {
//   hostSocketId, players: {A: socketId|null, B: socketId|null},
//   ready: {A:false, B:false}, started: false
// }
const rooms = {};

function genCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms[code]);
  return code;
}

function presence(room) {
  return { A: !!room.players.A, B: !!room.players.B };
}

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.slot = null;
  socket.data.isHost = false;

  // Latency diagnostic ping used by controller.html
  socket.on('ping_check', (cb) => {
    if (typeof cb === 'function') cb();
  });

  // ── HOST: create a new room ──
  socket.on('create_game', () => {
    const code = genCode();
    rooms[code] = {
      hostSocketId: socket.id,
      players: { A: null, B: null },
      ready: { A: false, B: false },
      started: false
    };
    socket.data.code = code;
    socket.data.isHost = true;
    socket.join(code);
    socket.emit('game_created', { code });
  });

  // ── CONTROLLER: join an existing room ──
  socket.on('join_game', ({ code }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('join_error', 'room not found');
      return;
    }
    let slot = null;
    if (!room.players.A) slot = 'A';
    else if (!room.players.B) slot = 'B';
    else {
      socket.emit('join_error', 'room full');
      return;
    }
    room.players[slot] = socket.id;
    socket.data.code = code;
    socket.data.slot = slot;
    socket.join(code);

    socket.emit('joined', { slot, code });
    io.to(code).emit('player_joined', { slot, players: presence(room) });

    if (room.started) {
      // Game already running — drop this controller straight into the joystick
      socket.emit('game_start');
    }
  });

  // ── CONTROLLER: reconnect after a dropped socket ──
  socket.on('rejoin_game', ({ code, slot }) => {
    const room = rooms[code];
    if (!room || !slot) return;
    room.players[slot] = socket.id;
    socket.data.code = code;
    socket.data.slot = slot;
    socket.join(code);

    socket.emit('joined', { slot, code });
    io.to(code).emit('player_joined', { slot, players: presence(room) });
    io.to(code).emit('game_event', {
      event: 'lobby_ready_update',
      data: { ...presence(room), readyA: room.ready.A, readyB: room.ready.B }
    });
    if (room.started) socket.emit('game_start');
  });

  // ── CONTROLLER: ready up in the lobby ──
  socket.on('player_ready', ({ code }) => {
    const room = rooms[code];
    if (!room || !socket.data.slot) return;
    room.ready[socket.data.slot] = true;

    io.to(code).emit('game_event', {
      event: 'lobby_ready_update',
      data: { ...presence(room), readyA: room.ready.A, readyB: room.ready.B }
    });

    if (room.players.A && room.players.B && room.ready.A && room.ready.B) {
      io.to(room.hostSocketId).emit('both_ready');
    }
  });

  // ── HOST: kick off the match once difficulty is picked ──
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return;
    room.started = true;
    io.to(code).emit('game_start');
  });

  // ── HOST: back to lobby after a match ends ──
  socket.on('reset_lobby', ({ code }) => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostSocketId) return;
    room.started = false;
    room.ready = { A: false, B: false };
    io.to(code).emit('game_event', {
      event: 'lobby_ready_update',
      data: { ...presence(room), readyA: false, readyB: false }
    });
  });

  // ── CONTROLLER: relay a directional / action press to the host ──
  socket.on('ctrl_input', ({ code, slot, dir, pressed }) => {
    const room = rooms[code];
    if (!room) return;
    io.to(room.hostSocketId).emit('ctrl_input', { slot, dir, pressed });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (socket.data.isHost && room.hostSocketId === socket.id) {
      io.to(code).emit('host_disconnected');
      delete rooms[code];
      return;
    }

    const slot = socket.data.slot;
    if (slot && room.players[slot] === socket.id) {
      room.players[slot] = null;
      room.ready[slot] = false;
      io.to(code).emit('player_left', { slot });
      io.to(code).emit('game_event', {
        event: 'lobby_ready_update',
        data: { ...presence(room), readyA: room.ready.A, readyB: room.ready.B }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Math Duel server running on http://localhost:${PORT}`);
  console.log('Open this on your TV/PC, and have players join from their phones on the same network.');
});
