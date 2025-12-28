const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * Room state (in-memory):
 * phase: "lobby" | "armed" | "locked"
 * timer: authoritative, server-driven
 */
const rooms = new Map(); // roomCode -> roomState

function randomString(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateRoomCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid 0/O/1/I
  let code = "";
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createUniqueRoomCode() {
  let code;
  do {
    code = generateRoomCode(4);
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const roomCode = createUniqueRoomCode();
  const hostKey = randomString(20);

  rooms.set(roomCode, {
    roomCode,
    hostKey,
    createdAt: Date.now(),
    membersCount: 0,

    // game state
    phase: "lobby",
    armedAt: null,
    lockedBy: null,

    // timer state
    durationMs: 15000,
    remainingMs: 15000,
    timerRunning: false,
    timerLastTickAt: null
  });

  return { roomCode, hostKey };
}

function publicRoomState(room) {
  return {
    roomCode: room.roomCode,
    membersCount: room.membersCount,
    phase: room.phase,
    armedAt: room.armedAt,
    lockedBy: room.lockedBy,

    durationMs: room.durationMs,
    remainingMs: room.remainingMs,
    timerRunning: room.timerRunning
  };
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("roomState", publicRoomState(room));
}

function isHost(socket, room) {
  return Boolean(socket?.data?.isHost && room);
}

/**
 * Timer tick loop: global, lightweight.
 * Decrements remainingMs for rooms where timerRunning is true.
 */
const TICK_MS = 200;

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.timerRunning) continue;

    if (room.timerLastTickAt == null) room.timerLastTickAt = now;

    const delta = now - room.timerLastTickAt;
    if (delta <= 0) continue;

    room.timerLastTickAt = now;
    room.remainingMs = Math.max(0, room.remainingMs - delta);

    // If time is up, end the round
    if (room.remainingMs === 0) {
      room.timerRunning = false;
      room.timerLastTickAt = null;

      // End round: back to lobby, disarm
      room.phase = "lobby";
      room.armedAt = null;
      room.lockedBy = null;
    }
  }

  // Broadcast state periodically (we can do it every tick; still fine for small classes)
  for (const room of rooms.values()) {
    if (room.timerRunning || room.remainingMs === 0) {
      emitRoomState(room.roomCode);
    }
  }
}, TICK_MS);

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));

// Create room endpoint
app.get("/api/rooms/create", (req, res) => {
  const { roomCode, hostKey } = createRoom();
  res.json({ roomCode, hostKey });
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", ({ roomCode, hostKey } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code) return socket.emit("errorMsg", "Room code is required.");
    const room = rooms.get(code);
    if (!room) return socket.emit("errorMsg", `Room "${code}" does not exist.`);

    // Leave any previous room (1 room per socket)
    for (const r of socket.rooms) {
      if (r !== socket.id) socket.leave(r);
    }

    socket.join(code);
    socket.data.roomCode = code;

    socket.data.isHost = Boolean(hostKey && hostKey === room.hostKey);

    room.membersCount += 1;

    socket.emit("joinedRoom", { roomCode: code, isHost: socket.data.isHost });
    emitRoomState(code);

    console.log(`${socket.id} joined room ${code} (host=${socket.data.isHost})`);
  });

  // Host: set duration (seconds)
  socket.on("hostSetDuration", ({ seconds }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0 || s > 600) {
      return socket.emit("errorMsg", "Duration must be between 1 and 600 seconds.");
    }

    room.durationMs = Math.floor(s * 1000);

    // Only reset remaining time if timer isn't running (keeps behavior predictable)
    if (!room.timerRunning) room.remainingMs = room.durationMs;

    emitRoomState(roomCode);
  });

  // Host: arm buzzer (beep moment)
  socket.on("hostArm", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.phase = "armed";
    room.armedAt = Date.now();
    room.lockedBy = null;

    // reset timer but do not start automatically
    room.timerRunning = false;
    room.timerLastTickAt = null;
    room.remainingMs = room.durationMs;

    emitRoomState(roomCode);
  });

  // Host: start/resume timer
  socket.on("hostStartTimer", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    if (room.phase !== "armed") {
      return socket.emit("errorMsg", "You can start timer only when phase is ARMED.");
    }
    if (room.remainingMs <= 0) room.remainingMs = room.durationMs;

    room.timerRunning = true;
    room.timerLastTickAt = Date.now();
    emitRoomState(roomCode);
  });

  // Host: pause timer
  socket.on("hostPauseTimer", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.timerRunning = false;
    room.timerLastTickAt = null;
    emitRoomState(roomCode);
  });

  // Host: correct -> end round (lobby, timer stop)
  socket.on("hostCorrect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.phase = "lobby";
    room.lockedBy = null;
    room.armedAt = null;

    room.timerRunning = false;
    room.timerLastTickAt = null;
    room.remainingMs = room.durationMs;

    emitRoomState(roomCode);
  });

  // Host: incorrect -> release lock, keep armed, resume timer (if time left)
  socket.on("hostIncorrect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    if (room.phase === "locked") {
      room.phase = "armed";
      room.lockedBy = null;

      // resume timer if time left
      if (room.remainingMs > 0) {
        room.timerRunning = true;
        room.timerLastTickAt = Date.now();
      }

      emitRoomState(roomCode);
    }
  });

  // Player: buzz
  socket.on("buzz", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");

    // Not armed / locked / time up
    if (room.phase !== "armed") {
      socket.emit("buzzRejected", { reason: room.phase === "lobby" ? "NOT_ARMED" : "LOCKED" });
      return;
    }
    if (room.remainingMs <= 0) {
      socket.emit("buzzRejected", { reason: "TIME_UP" });
      return;
    }

    // First buzz wins: lock and pause timer
    room.phase = "locked";
    room.lockedBy = socket.id;

    room.timerRunning = false;
    room.timerLastTickAt = null;

    io.to(roomCode).emit("buzzed", { by: socket.id, roomCode });
    emitRoomState(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      room.membersCount = Math.max(0, room.membersCount - 1);

      // If locked player disconnected, unlock and resume timer (if time left)
      if (room.lockedBy === socket.id) {
        room.lockedBy = null;
        room.phase = room.armedAt ? "armed" : "lobby";
        if (room.phase === "armed" && room.remainingMs > 0) {
          room.timerRunning = true;
          room.timerLastTickAt = Date.now();
        }
      }

      emitRoomState(roomCode);
    }
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
