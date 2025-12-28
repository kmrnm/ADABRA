const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/**
 * Room state:
 * phase: "lobby" | "armed" | "locked"
 * teams: A and B (for now)
 * - scores
 * - lockouts per round
 * - who buzzed (socket + team) for host correct/incorrect
 */
const rooms = new Map(); // roomCode -> roomState

function randomString(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateRoomCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createUniqueRoomCode() {
  let code;
  do code = generateRoomCode(4);
  while (rooms.has(code));
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

    // last buzz info (for host decision)
    lockedBySocketId: null,
    lockedByTeam: null,

    // timer
    durationMs: 15000,
    remainingMs: 15000,
    timerRunning: false,
    timerLastTickAt: null,

    // teams
    teams: {
      A: { name: "Team A", score: 0 },
      B: { name: "Team B", score: 0 }
    },

    // per-round lockout: set of team IDs ("A" or "B") that cannot buzz again this round
    lockedOutTeams: new Set()
  });

  return { roomCode, hostKey };
}

function publicRoomState(room) {
  return {
    roomCode: room.roomCode,
    membersCount: room.membersCount,
    phase: room.phase,
    armedAt: room.armedAt,

    durationMs: room.durationMs,
    remainingMs: room.remainingMs,
    timerRunning: room.timerRunning,

    lockedBySocketId: room.lockedBySocketId,
    lockedByTeam: room.lockedByTeam,

    teams: {
      A: { name: room.teams.A.name, score: room.teams.A.score },
      B: { name: room.teams.B.name, score: room.teams.B.score }
    },
    lockedOutTeams: Array.from(room.lockedOutTeams)
  };
}

function emitRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("roomState", publicRoomState(room));
}

function requireRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) {
    socket.emit("errorMsg", "Join a room first.");
    return null;
  }
  const room = rooms.get(roomCode);
  if (!room) {
    socket.emit("errorMsg", "Room not found.");
    return null;
  }
  return room;
}

function isHost(socket, room) {
  return Boolean(socket?.data?.isHost && room);
}

function resetRound(room) {
  room.phase = "lobby";
  room.armedAt = null;
  room.lockedBySocketId = null;
  room.lockedByTeam = null;

  room.timerRunning = false;
  room.timerLastTickAt = null;
  room.remainingMs = room.durationMs;

  room.lockedOutTeams.clear();
}

/** Timer loop */
const TICK_MS = 200;
setInterval(() => {
  const now = Date.now();
  let anyEmitted = false;

  for (const room of rooms.values()) {
    if (!room.timerRunning) continue;

    if (room.timerLastTickAt == null) room.timerLastTickAt = now;
    const delta = now - room.timerLastTickAt;
    if (delta <= 0) continue;

    room.timerLastTickAt = now;
    room.remainingMs = Math.max(0, room.remainingMs - delta);

    if (room.remainingMs === 0) {
      room.timerRunning = false;
      room.timerLastTickAt = null;
      resetRound(room); // time up ends round
    }

    emitRoomState(room.roomCode);
    anyEmitted = true;
  }

  // avoid extra emissions; timer-running rooms already emitted
  if (anyEmitted) return;
}, TICK_MS);

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));

// Create room
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

    // Leave previous (1 room per socket)
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = Boolean(hostKey && hostKey === room.hostKey);

    room.membersCount += 1;

    socket.emit("joinedRoom", { roomCode: code, isHost: socket.data.isHost });
    emitRoomState(code);
  });

  // Player picks team: "A" or "B"
  socket.on("setTeam", ({ teamId } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    const t = String(teamId || "").toUpperCase();
    if (t !== "A" && t !== "B") {
      socket.emit("errorMsg", "Team must be A or B.");
      return;
    }
    socket.data.teamId = t;
    socket.emit("teamSet", { teamId: t });
    emitRoomState(room.roomCode);
  });

  // Host: set duration seconds
  socket.on("hostSetDuration", ({ seconds }) => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0 || s > 600) {
      return socket.emit("errorMsg", "Duration must be between 1 and 600 seconds.");
    }

    room.durationMs = Math.floor(s * 1000);
    if (!room.timerRunning) room.remainingMs = room.durationMs;

    emitRoomState(room.roomCode);
  });

  // Host: arm round (beep) -> clears per-round lockouts
  socket.on("hostArm", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.phase = "armed";
    room.armedAt = Date.now();
    room.lockedBySocketId = null;
    room.lockedByTeam = null;

    room.lockedOutTeams.clear();

    room.timerRunning = false;
    room.timerLastTickAt = null;
    room.remainingMs = room.durationMs;

    emitRoomState(room.roomCode);
  });

  socket.on("hostStartTimer", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");
    if (room.phase !== "armed") return socket.emit("errorMsg", "Start timer only when ARMED.");

    if (room.remainingMs <= 0) room.remainingMs = room.durationMs;
    room.timerRunning = true;
    room.timerLastTickAt = Date.now();
    emitRoomState(room.roomCode);
  });

  socket.on("hostPauseTimer", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.timerRunning = false;
    room.timerLastTickAt = null;
    emitRoomState(room.roomCode);
  });

  // Host: incorrect -> lock out that team, unlock, resume timer
  socket.on("hostIncorrect", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    if (room.phase !== "locked") return;

    // lock out the team that buzzed
    if (room.lockedByTeam) room.lockedOutTeams.add(room.lockedByTeam);

    // unlock, keep armed
    room.phase = "armed";
    room.lockedBySocketId = null;
    room.lockedByTeam = null;

    if (room.remainingMs > 0) {
      room.timerRunning = true;
      room.timerLastTickAt = Date.now();
    }

    emitRoomState(room.roomCode);
  });

  // Host: correct -> give point to last buzzing team, end round
  socket.on("hostCorrect", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    if (room.phase !== "locked") return;

    if (room.lockedByTeam && room.teams[room.lockedByTeam]) {
      room.teams[room.lockedByTeam].score += 1;
    }

    resetRound(room);
    emitRoomState(room.roomCode);
  });

  // Host manual score adjust
  socket.on("hostAdjustScore", ({ teamId, delta }) => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const t = String(teamId || "").toUpperCase();
    const d = Number(delta);

    if ((t !== "A" && t !== "B") || !Number.isFinite(d) || !Number.isInteger(d) || Math.abs(d) > 10) {
      return socket.emit("errorMsg", "Invalid score adjustment.");
    }

    room.teams[t].score += d;
    emitRoomState(room.roomCode);
  });

  // Player buzz
  socket.on("buzz", () => {
    const room = requireRoom(socket);
    if (!room) return;

    const teamId = socket.data.teamId;
    if (teamId !== "A" && teamId !== "B") {
      socket.emit("buzzRejected", { reason: "NO_TEAM" });
      return;
    }

    if (room.phase !== "armed") {
      socket.emit("buzzRejected", { reason: room.phase === "lobby" ? "NOT_ARMED" : "LOCKED" });
      return;
    }

    if (room.remainingMs <= 0) {
      socket.emit("buzzRejected", { reason: "TIME_UP" });
      return;
    }

    // team lockout rule
    if (room.lockedOutTeams.has(teamId)) {
      socket.emit("buzzRejected", { reason: "TEAM_LOCKED_OUT" });
      return;
    }

    // lock the round
    room.phase = "locked";
    room.lockedBySocketId = socket.id;
    room.lockedByTeam = teamId;

    // pause timer
    room.timerRunning = false;
    room.timerLastTickAt = null;

    io.to(room.roomCode).emit("buzzed", { by: socket.id, teamId, roomCode: room.roomCode });
    emitRoomState(room.roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      room.membersCount = Math.max(0, room.membersCount - 1);

      // If locked socket left, unlock and resume timer
      if (room.lockedBySocketId === socket.id) {
        room.lockedBySocketId = null;
        room.lockedByTeam = null;
        room.phase = room.armedAt ? "armed" : "lobby";
        if (room.phase === "armed" && room.remainingMs > 0) {
          room.timerRunning = true;
          room.timerLastTickAt = Date.now();
        }
      }

      emitRoomState(roomCode);
    }
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
