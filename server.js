const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

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

function makeTeams(initialCount) {
  const teams = {};
  for (let i = 1; i <= initialCount; i++) {
    const id = String(i);
    teams[id] = { id, name: `Team ${i}`, score: 0 };
  }
  return teams;
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
    phase: "lobby", // "lobby" | "armed" | "locked"
    armedAt: null,

    lockedBySocketId: null,
    lockedByTeamId: null,

    // timer
    durationMs: 15000,
    remainingMs: 15000,
    timerRunning: false,
    timerLastTickAt: null,

    // teams (dynamic)
    teams: makeTeams(2), // start with 2 teams
    maxTeams: 6,

    // per-round lockout
    lockedOutTeams: new Set(),

    // permanent team assignment per room (survives refresh)
    // playerId -> teamId
    playerTeams: new Map()
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
    lockedByTeamId: room.lockedByTeamId,

    teams: Object.values(room.teams).map((t) => ({ id: t.id, name: t.name, score: t.score })),
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
  room.lockedByTeamId = null;

  room.timerRunning = false;
  room.timerLastTickAt = null;
  room.remainingMs = room.durationMs;

  room.lockedOutTeams.clear();
}

/** Timer loop */
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

    if (room.remainingMs === 0) {
      room.timerRunning = false;
      room.timerLastTickAt = null;
      resetRound(room);
    }

    emitRoomState(room.roomCode);
  }
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
  socket.on("joinRoom", ({ roomCode, hostKey, playerId } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code) return socket.emit("errorMsg", "Room code is required.");

    const room = rooms.get(code);
    if (!room) return socket.emit("errorMsg", `Room "${code}" does not exist.`);

    // Leave previous room (1 room per socket)
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);

    socket.join(code);
    socket.data.roomCode = code;

    // host auth
    socket.data.isHost = Boolean(hostKey && hostKey === room.hostKey);

    // player identity (for refresh persistence)
    if (playerId && typeof playerId === "string") {
      socket.data.playerId = playerId;
    }

    room.membersCount += 1;

    socket.emit("joinedRoom", { roomCode: code, isHost: socket.data.isHost });

    // If this is a player reconnect, re-send their existing team (if any)
    if (!socket.data.isHost && socket.data.playerId) {
      const existingTeam = room.playerTeams.get(socket.data.playerId);
      if (existingTeam) {
        socket.data.teamId = existingTeam;
        socket.emit("teamSet", { teamId: existingTeam, locked: true });
      }
    }

    emitRoomState(code);
  });

  /**
   * Host can INCREASE teams (up to 6).
   * This does NOT reset scores.
   */
  socket.on("hostSetTeamCount", ({ count } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const desired = Number(count);
    if (!Number.isInteger(desired) || desired < 2 || desired > room.maxTeams) {
      return socket.emit("errorMsg", "Team count must be between 2 and 6.");
    }

    const currentCount = Object.keys(room.teams).length;
    if (desired < currentCount) {
      return socket.emit("errorMsg", "You can only increase team count (not decrease) for now.");
    }
    if (desired === currentCount) return;

    // Add new teams
    for (let i = currentCount + 1; i <= desired; i++) {
      const id = String(i);
      room.teams[id] = { id, name: `Team ${i}`, score: 0 };
    }

    emitRoomState(room.roomCode);
  });

  /**
   * Player chooses team ONCE.
   * If already assigned (server-side), reject changes.
   */
  socket.on("setTeam", ({ teamId } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    if (socket.data.isHost) return socket.emit("errorMsg", "Host cannot select a team.");

    if (!socket.data.playerId) {
      return socket.emit("errorMsg", "Missing playerId. Refresh /play page.");
    }

    const existing = room.playerTeams.get(socket.data.playerId);
    if (existing) {
      // already locked forever for this room
      socket.data.teamId = existing;
      socket.emit("teamSet", { teamId: existing, locked: true });
      return;
    }

    const t = String(teamId || "").trim();
    if (!room.teams[t]) return socket.emit("errorMsg", "Invalid team.");

    // assign permanently
    room.playerTeams.set(socket.data.playerId, t);
    socket.data.teamId = t;

    socket.emit("teamSet", { teamId: t, locked: true });
    emitRoomState(room.roomCode);
  });

  // Host: duration
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

  // Host: arm (beep) resets per-round lockouts
  socket.on("hostArm", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.phase = "armed";
    room.armedAt = Date.now();
    room.lockedBySocketId = null;
    room.lockedByTeamId = null;

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

  // Host: incorrect -> lock out buzzing team, unlock, resume timer
  socket.on("hostIncorrect", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");
    if (room.phase !== "locked") return;

    if (room.lockedByTeamId) room.lockedOutTeams.add(room.lockedByTeamId);

    room.phase = "armed";
    room.lockedBySocketId = null;
    room.lockedByTeamId = null;

    if (room.remainingMs > 0) {
      room.timerRunning = true;
      room.timerLastTickAt = Date.now();
    }

    emitRoomState(room.roomCode);
  });

  // Host: correct -> +1 to buzzing team, end round
  socket.on("hostCorrect", () => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");
    if (room.phase !== "locked") return;

    if (room.lockedByTeamId && room.teams[room.lockedByTeamId]) {
      room.teams[room.lockedByTeamId].score += 1;
    }

    resetRound(room);
    emitRoomState(room.roomCode);
  });

  // Host manual score adjust
  socket.on("hostAdjustScore", ({ teamId, delta }) => {
    const room = requireRoom(socket);
    if (!room) return;
    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const t = String(teamId || "").trim();
    const d = Number(delta);

    if (!room.teams[t] || !Number.isInteger(d) || Math.abs(d) > 10) {
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
    if (!teamId) return socket.emit("buzzRejected", { reason: "NO_TEAM" });

    if (room.phase !== "armed") {
      return socket.emit("buzzRejected", { reason: room.phase === "lobby" ? "NOT_ARMED" : "LOCKED" });
    }
    if (room.remainingMs <= 0) return socket.emit("buzzRejected", { reason: "TIME_UP" });

    if (room.lockedOutTeams.has(teamId)) {
      return socket.emit("buzzRejected", { reason: "TEAM_LOCKED_OUT" });
    }

    room.phase = "locked";
    room.lockedBySocketId = socket.id;
    room.lockedByTeamId = teamId;

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

      if (room.lockedBySocketId === socket.id) {
        room.lockedBySocketId = null;
        room.lockedByTeamId = null;
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