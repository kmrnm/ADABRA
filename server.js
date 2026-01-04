const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map(); // roomCode -> roomState

function touchRoom(room) {
  if (!room) return;
  room.lastActivityAt = Date.now();
}

function randomString(len = 20) {
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

function makeTeams(count) {
  const teams = {};
  for (let i = 1; i <= count; i++) {
    const id = String(i);
    teams[id] = { id, name: `Team ${i}`, score: 0 };
  }
  return teams;
}

function createRoom() {
  const roomCode = createUniqueRoomCode();
  const hostKey = randomString(24);

  rooms.set(roomCode, {
    roomCode,
    hostKey,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    timeUpAt: null,
    membersCount: 0,

    teamTaken: new Map(),
    teamNameLocked: new Set(), // teamId: can rename only once per session

    // round state
    phase: "lobby", // "lobby" | "armed" | "locked"
    roundNumber: 0,

    // timing
    durationMs: 15000,
    remainingMs: 15000,
    timerRunning: false,
    timerLastTickAt: null,

    // buzz state
    lockedBySocketId: null,
    lockedByTeamId: null,
    lastBuzz: null, // { by, teamId } or null
    lockedByPlayerId: null,

    // teams
    maxTeams: 6,
    teams: makeTeams(2),

    // per-round lockout: teams that cannot buzz again after incorrect
    lockedOutTeams: new Set(),

    // persistent player identity for team choice (refresh-safe)
    playerTeams: new Map(), // playerId -> teamId
  });

  return { roomCode, hostKey };
}

function publicRoomState(room) {
  return {
    roomCode: room.roomCode,
    membersCount: room.membersCount,

    tablesChosenCount: room.teamTaken.size,

    phase: room.phase,
    roundNumber: room.roundNumber,

    durationMs: room.durationMs,
    remainingMs: room.remainingMs,
    timerRunning: room.timerRunning,
    timeUpAt: room.timeUpAt,

    lockedBySocketId: room.lockedBySocketId,
    lockedByTeamId: room.lockedByTeamId,

    lastBuzz: room.lastBuzz,
    lockedOutTeams: Array.from(room.lockedOutTeams),

    teams: Object.values(room.teams).map(t => ({ id: t.id, name: t.name, score: t.score })),

    takenTeams: Array.from(room.teamTaken.entries()).map(([teamId, playerId]) => ({ teamId, playerId })),
    teamNameLocked: Array.from(room.teamNameLocked),

    firstBuzzTeamId: room.firstBuzzTeamId,
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

function resetToLobby(room) {
  room.phase = "lobby";

  room.timerRunning = false;
  room.timerLastTickAt = null;
  room.remainingMs = room.durationMs;

  room.lockedBySocketId = null;
  room.lockedByTeamId = null;

  room.lastBuzz = null;
  room.lockedOutTeams.clear();

  room.firstBuzzTeamId = null;
  room.lockedByPlayerId = null;
}

// Timer loop
const TICK_MS = 200;
setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.timerRunning) continue;
    touchRoom(room);
    if (room.timerLastTickAt == null) room.timerLastTickAt = now;
    const delta = now - room.timerLastTickAt;
    if (delta <= 0) continue;

    room.timerLastTickAt = now;
    room.remainingMs = Math.max(0, room.remainingMs - delta);

    if (room.remainingMs === 0) {
      room.timeUpAt = Date.now(); 

      room.timerRunning = false;
      room.timerLastTickAt = null;

      room.remainingMs = 0;

      resetToLobby(room);
      room.remainingMs = 0;

      io.to(room.roomCode).emit("timeUp");
      emitRoomState(room.roomCode);
      continue;
    }
    emitRoomState(room.roomCode);
  }
}, TICK_MS);

const ROOM_TTL = 30 * 60 * 1000;
const ROOM_CLEANUP_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms.entries()) {
    const idleMs = now - (room.lastActivityAt || room.createdAt || now);

    const EMPTY_GRACE_MS = 2 * 60 * 1000; // 2 minutes grace for newly created rooms
    const emptyTooLong = room.membersCount === 0 && idleMs > EMPTY_GRACE_MS;
    const idleTooLong = idleMs > ROOM_TTL;

    if (idleTooLong || emptyTooLong) {
      rooms.delete(code);
      console.log(`Deleted room ${code} (idleMs=${idleMs}, members=${room.membersCount})`);
    }
  }
}, ROOM_CLEANUP_MS);


// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));
app.get("/screen", (req, res) => res.sendFile(path.join(__dirname, "public", "screen.html")));

// API: create room
app.get("/api/rooms/create", (req, res) => {
  const data = createRoom();
  res.json(data);
});

io.on("connection", (socket) => {
  socket.on("joinRoom", ({ roomCode, hostKey, playerId } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code) return socket.emit("errorMsg", "Room code is required.");

    const room = rooms.get(code);
    if (!room) return socket.emit("errorMsg", `Room "${code}" does not exist.`);

    // leave old rooms
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);

    socket.join(code);
    socket.data.roomCode = code;

    socket.data.isHost = Boolean(hostKey && hostKey === room.hostKey);

    if (playerId && typeof playerId === "string") socket.data.playerId = playerId;

    room.membersCount += 1;

    socket.emit("joinedRoom", { roomCode: code, isHost: socket.data.isHost });

    // refresh-safe team restore
    if (!socket.data.isHost && socket.data.playerId) {
      const existingTeam = room.playerTeams.get(socket.data.playerId);
      if (existingTeam) {
        socket.data.teamId = existingTeam;
        socket.emit("teamSet", { teamId: existingTeam, locked: true });
      }
    }

    emitRoomState(code);
  });

  // Player chooses team ONCE per room (server authoritative)
  socket.on("setTeam", ({ teamId } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (socket.data.isHost) return socket.emit("errorMsg", "Host cannot select a team.");
    if (!socket.data.playerId) return socket.emit("errorMsg", "Missing playerId. Refresh /play.");

    const requested = String(teamId || "").trim();
    if (!room.teams[requested]) return socket.emit("errorMsg", "Invalid team.");

    // If this player already has a team, keep it (cannot change)
    const existing = room.playerTeams.get(socket.data.playerId);
    if (existing) {
      socket.data.teamId = existing;
      socket.emit("teamSet", { teamId: existing, locked: true });
      return;
    }

    // Enforce one-device-per-team
    const takenBy = room.teamTaken.get(requested);
    if (takenBy && takenBy !== socket.data.playerId) {
      return socket.emit("errorMsg", "This team is already taken in this room.");
    }

    // Assign
    room.playerTeams.set(socket.data.playerId, requested);
    room.teamTaken.set(requested, socket.data.playerId);
    socket.data.teamId = requested;

    socket.emit("teamSet", { teamId: requested, locked: true });
    emitRoomState(room.roomCode);
  });

  socket.on("setTeamName", ({ name } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (socket.data.isHost) return socket.emit("errorMsg", "Host cannot set team name.");

    const teamId = socket.data.teamId;
    if (!teamId) return socket.emit("errorMsg", "Choose a team first.");

    // Must own the team (unique per device)
    const playerId = socket.data.playerId;
    const takenBy = room.teamTaken.get(teamId);
    if (!playerId || takenBy !== playerId) {
      return socket.emit("errorMsg", "You do not own this team.");
    }

    // Only once per session
    if (room.teamNameLocked.has(teamId)) {
      return socket.emit("errorMsg", "Team name can be changed only once per session.");
    }

    // Validate name
    const cleaned = String(name || "").trim();
    if (cleaned.length < 2 || cleaned.length > 16) {
      return socket.emit("errorMsg", "Team name must be 2–16 characters.");
    }
    // Very simple sanitization
    const safe = cleaned.replace(/\s+/g, " ");

    room.teams[teamId].name = safe;
    room.teamNameLocked.add(teamId);

    emitRoomState(room.roomCode); // immediately updates host + all players
  });


  // Host: increase team count (2..6) - only increases, doesn’t reset scores
  socket.on("hostSetTeamCount", ({ count } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const desired = Number(count);
    if (!Number.isInteger(desired) || desired < 2 || desired > room.maxTeams) {
      return socket.emit("errorMsg", "Team count must be between 2 and 6.");
    }

    const current = Object.keys(room.teams).length;
    if (desired < current) return socket.emit("errorMsg", "Can only increase team count for now.");
    if (desired === current) return;

    for (let i = current + 1; i <= desired; i++) {
      const id = String(i);
      room.teams[id] = { id, name: `Team ${i}`, score: 0 };
    }

    emitRoomState(room.roomCode);
  });

  // Host: set round duration
  socket.on("hostSetDuration", ({ seconds } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0 || s > 600) {
      return socket.emit("errorMsg", "Duration must be 1..600 seconds.");
    }

    room.durationMs = Math.floor(s * 1000);
    if (!room.timerRunning) room.remainingMs = room.durationMs;

    emitRoomState(room.roomCode);
  });

  // Host: Next Round (paper mode) — reset everything and increment round counter
  socket.on("hostNextRound", () => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.roundNumber += 1;
    room.timeUpAt = null;
    resetToLobby(room);
    emitRoomState(room.roomCode);
  });

  // Host: Beep + Start (one button)
  socket.on("hostBeepStart", () => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.timeUpAt = null;

    //room.roundNumber += 1;

    // start armed round
    room.phase = "armed";
    room.lockedBySocketId = null;
    room.lockedByTeamId = null;
    room.lastBuzz = null;
    room.lockedOutTeams.clear();

    room.firstBuzzTeamId = null;

    room.remainingMs = room.durationMs;
    room.timerRunning = true;
    room.timerLastTickAt = Date.now();

    io.to(room.roomCode).emit("beep");
    emitRoomState(room.roomCode);
  });

  socket.on("hostPauseTimer", () => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    room.timerRunning = false;
    room.timerLastTickAt = null;
    emitRoomState(room.roomCode);
  });

  // Host: Incorrect — lock out that team for this round, resume timer
  socket.on("hostIncorrect", () => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");
    if (room.phase !== "locked") return;

    if (room.lockedByTeamId) room.lockedOutTeams.add(room.lockedByTeamId);

    room.phase = "armed";
    room.firstBuzzTeamId = null;
    room.lockedBySocketId = null;
    room.lockedByTeamId = null;

    // resume timer if time remains
    if (room.remainingMs > 0) {
      room.timerRunning = true;
      room.timerLastTickAt = Date.now();
    }

    emitRoomState(room.roomCode);
  });

  // Host: Correct — +1 point (paper mode), end round (back to lobby)
  socket.on("hostCorrect", () => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");
    if (room.phase !== "locked") return;

    let scoredTeamId = null;

    if (room.lockedByTeamId && room.teams[room.lockedByTeamId]) {
      room.teams[room.lockedByTeamId].score += 1;
      scoredTeamId = String(room.lockedByTeamId);
    }

    if (scoredTeamId) {
      io.to(room.roomCode).emit("correctFx", { teamId: scoredTeamId });
    }

    room.roundNumber += 1;
    room.timeUpAt = null;

    resetToLobby(room);
    emitRoomState(room.roomCode);

  });

  socket.on("hostAdjustScore", ({ teamId, delta } = {}) => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    if (!isHost(socket, room)) return socket.emit("errorMsg", "Host only.");

    const t = String(teamId || "").trim();
    const d = Number(delta);

    if (!room.teams[t] || !Number.isInteger(d) || Math.abs(d) > 100) {
      return socket.emit("errorMsg", "Invalid score adjustment.");
    }

    room.teams[t].score += d;
    emitRoomState(room.roomCode);
  });

  // Player buzz (no false-start feature)
  socket.on("buzz", () => {
    const room = requireRoom(socket);
    if (!room) return;

    touchRoom(room);

    const teamId = socket.data.teamId;
    const playerId = socket.data.playerId;

    if (!teamId || !playerId) return socket.emit("buzzRejected", { reason: "NO_TEAM" });

    if (room.phase !== "armed") {
      return socket.emit("buzzRejected", { reason: "NOT_ARMED" });
    }

    if (room.remainingMs <= 0) {
      return socket.emit("buzzRejected", { reason: "TIME_UP" });
    }

    if (room.lockedOutTeams.has(teamId)) {
      return socket.emit("buzzRejected", { reason: "TEAM_LOCKED_OUT" });
    }

    room.phase = "locked";

    // IMPORTANT: lock by PLAYER + TEAM, not socket
    room.lockedByPlayerId = playerId;
    room.lockedByTeamId = teamId;

    if (!room.firstBuzzTeamId) room.firstBuzzTeamId = teamId;

    room.lastBuzz = { by: playerId, teamId };

    // pause timer while answering
    room.timerRunning = false;
    room.timerLastTickAt = null;

    io.to(room.roomCode).emit("buzzed", { teamId, roomCode: room.roomCode });
    emitRoomState(room.roomCode);
  });


  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms.has(roomCode)) return;

    const room = rooms.get(roomCode);
    room.membersCount = Math.max(0, room.membersCount - 1);

    if (room.phase === "locked" && room.lockedByPlayerId && socket.data.playerId === room.lockedByPlayerId) {
      // Keep locked + keep timer paused.
      // Host can still judge Correct/Incorrect.
      emitRoomState(roomCode);
      return;
    }

    emitRoomState(roomCode);
  });

  socket.on("rejoinRoom", ({ roomCode, playerId } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code || !playerId) return;

    const room = rooms.get(code);
    if (!room) return;

    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = String(playerId);

    const existingTeam = room.playerTeams.get(socket.data.playerId);
    if (existingTeam) {
      socket.data.teamId = existingTeam;
      socket.emit("teamSet", { teamId: existingTeam, locked: true });
    }
    room.membersCount += 1;
    socket.emit("roomState", publicRoomState(room));
  });


});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
