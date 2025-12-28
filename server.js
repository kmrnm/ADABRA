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
    armedAt: null, // server timestamp when host armed (beep)
    lockedBy: null // socket.id that buzzed first
  });

  return { roomCode, hostKey };
}

function publicRoomState(room) {
  // Never leak hostKey to clients
  return {
    roomCode: room.roomCode,
    membersCount: room.membersCount,
    phase: room.phase,
    armedAt: room.armedAt,
    lockedBy: room.lockedBy
  };
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("roomState", publicRoomState(room));
}

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));

// Create room endpoint (host uses it)
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

    // Host identification (simple)
    socket.data.isHost = Boolean(hostKey && hostKey === room.hostKey);

    room.membersCount += 1;

    socket.emit("joinedRoom", { roomCode: code, isHost: socket.data.isHost });
    emitRoomState(code);

    console.log(`${socket.id} joined room ${code} (host=${socket.data.isHost})`);
  });

  // Host: arm buzzer (beep moment)
  socket.on("hostArm", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!socket.data.isHost) return socket.emit("errorMsg", "Host only.");

    room.phase = "armed";
    room.armedAt = Date.now();
    room.lockedBy = null;

    emitRoomState(roomCode);
  });

  // Host: mark correct -> end round (back to lobby)
  socket.on("hostCorrect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!socket.data.isHost) return socket.emit("errorMsg", "Host only.");

    room.phase = "lobby";
    room.lockedBy = null;
    room.armedAt = null;

    emitRoomState(roomCode);
  });

  // Host: incorrect -> release lock, keep armed (others can buzz)
  socket.on("hostIncorrect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");
    if (!socket.data.isHost) return socket.emit("errorMsg", "Host only.");

    // If already armed, just unlock; if lobby, do nothing
    if (room.phase === "locked") {
      room.phase = "armed";
      room.lockedBy = null;
      // keep armedAt as-is (the buzzer is still armed)
      emitRoomState(roomCode);
    }
  });

  // Player: buzz
  socket.on("buzz", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");
    const room = rooms.get(roomCode);
    if (!room) return socket.emit("errorMsg", "Room not found.");

    // False start or not allowed
    if (room.phase !== "armed") {
      // In classic rules, buzzing before beep is false start. For now: reject.
      socket.emit("buzzRejected", { reason: room.phase === "lobby" ? "NOT_ARMED" : "LOCKED" });
      return;
    }

    // First buzz wins
    room.phase = "locked";
    room.lockedBy = socket.id;

    io.to(roomCode).emit("buzzed", { by: socket.id, roomCode });
    emitRoomState(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      room.membersCount = Math.max(0, room.membersCount - 1);

      // If the locked player disconnected, release lock (simple)
      if (room.lockedBy === socket.id) {
        room.lockedBy = null;
        room.phase = room.armedAt ? "armed" : "lobby";
      }

      emitRoomState(roomCode);
    }

    console.log("User disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
