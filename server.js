const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// In-memory room store
const rooms = new Map(); // roomCode -> { createdAt, membersCount }

function generateRoomCode(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let code = "";
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createUniqueRoomCode() {
  let code;
  do {
    code = generateRoomCode(4);
  } while (rooms.has(code));
  rooms.set(code, { createdAt: Date.now(), membersCount: 0 });
  return code;
}

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(__dirname, "public", "play.html")));

// REST endpoint to create room
app.get("/api/rooms/create", (req, res) => {
  const code = createUniqueRoomCode();
  res.json({ roomCode: code });
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", ({ roomCode }) => {
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code) return socket.emit("errorMsg", "Room code is required.");
    if (!rooms.has(code)) return socket.emit("errorMsg", `Room "${code}" does not exist.`);

    // Leave any previous room (1 room per socket)
    for (const r of socket.rooms) {
      if (r !== socket.id) socket.leave(r);
    }

    socket.join(code);

    const room = rooms.get(code);
    room.membersCount += 1;
    socket.data.roomCode = code;

    socket.emit("joinedRoom", { roomCode: code });
    io.to(code).emit("roomInfo", { roomCode: code, membersCount: room.membersCount });

    console.log(`${socket.id} joined room ${code}`);
  });

  socket.on("buzz", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return socket.emit("errorMsg", "Join a room first.");

    io.to(roomCode).emit("buzzed", { by: socket.id, roomCode });
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      room.membersCount = Math.max(0, room.membersCount - 1);
      io.to(roomCode).emit("roomInfo", { roomCode, membersCount: room.membersCount });
    }
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
