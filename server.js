import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import express from "express";
import { fileURLToPath } from "url";
import { dirname } from "path";

const app = express();
const httpServer = createServer(app);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Middleware ===
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// === Health Check ===
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// === Static Files ===
app.use("/public", express.static(path.join(__dirname, "public")));

// === Socket.io Setup ===
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://abona-faltaus.vercel.app",
      "https://exam-group.glitch.me"
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

// === In-Memory Room Store ===
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // === Create Room ===
  socket.on("create-room", ({ roomId }, cb) => {
    if (rooms.has(roomId)) {
      socket.emit("room-error", "الغرفة موجودة بالفعل");
      return cb({ success: false, error: "غرفة موجودة" });
    }

    rooms.set(roomId, {
      adminId: socket.id,
      teams: [],
      admin: socket.id,
      status: "waiting",
      questions: [],
      currentQuestionIndex: 0,
    });

    socket.join(roomId);
    console.log(`✅ [ROOM CREATED] ${roomId} by ${socket.id}`);
    return cb({success: true});
  });

  // === Join Room ===
  socket.on("join-room", ({ roomId, team, isAdmin }) => {
    const room = rooms.get(roomId);
  
    if (!room) {
      socket.emit("room-error", "الغرفة غير موجودة");
      return;
    }

    if (isAdmin) {
      if (room.adminId === socket.id) {
        room.adminSocketId = socket.id;
        socket.join(roomId);
        socket.emit("teams-init", room.teams);
        socket.emit("room-joined", { isAdmin: true });
        if (room.status === "active" && room.questions.length > 0) {
          socket.emit("exam-started", {
            question: room.questions[room.currentQuestionIndex],
            timePerQuestion: room.timePerQuestion,
            totalQuestions: room.questions.length,
            index : 0,
          });
        }
        
      } else {
         socket.emit("room-error", "ليس لديك صلاحية المشرف");
      }
      return;
    }

    const existingTeam = room.teams.find((t) => t.id === team.id);

    if (!existingTeam) {
      const newTeam = {
        id: team.id,
        name: team.name,
        socketId: socket.id,
        score: 0,
        memberCount: team.memberCount,
        members: team.members || [],
      };
      room.teams.push(newTeam);
      socket.join(roomId);
      socket.emit("room-joined", { team: newTeam });
      io.to(room.admin).emit("team-joined", newTeam);
      console.log(`✅ [JOIN] Team ${team.name} joined room ${roomId}`);
    } else {
      existingTeam.socketId = socket.id;
      socket.join(roomId);
      socket.emit("room-joined", { team: existingTeam });
      console.log(`🔁 [REJOIN] Team ${existingTeam.name} reconnected to room ${roomId}`);
    }
  });

  // === Start Exam ===
  socket.on("start-exam", ({ roomId, settings }) => {
    const room = rooms.get(roomId);
    if (!room || room.admin !== socket.id) return;

    const selectedCategories = settings.categories.filter(Boolean);
    if (selectedCategories.length === 0) {
      socket.emit("exam-error", "لم يتم اختيار أي تصنيفات");
      return;
    }

    let questionsData = [];
    try {
      const questionsPath = path.join(__dirname, "public", "exam", "simple.json");
      questionsData = JSON.parse(fs.readFileSync(questionsPath, "utf8"));
    } catch (err) {
      console.error("❌ Failed to load questions:", err);
      socket.emit("exam-error", "تعذر تحميل الأسئلة");
      return;
    }

    let allQuestions = [];
    selectedCategories.forEach((category) => {
      const catData = questionsData.find((cat) => cat.category === category);
      if (catData) {
        allQuestions = allQuestions.concat(catData.questions);
      }
    });

    const shuffled = allQuestions.sort(() => Math.random() - 0.5).slice(0, settings.questionCount);

    room.questions = shuffled.map((q, index) => ({ ...q, id: index }));
    room.currentQuestionIndex = 0;
    room.timePerQuestion = settings.timePerQuestion;
    room.remainingTime = settings.timePerQuestion;
    room.qrSize = settings.defaultQrSize || 200; // px

    room.status = "active";
    io.to(room.admin).emit("teams-init", room.teams);
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.timerInterval = setInterval(() => {
    if (room.status !== "active") return;
    room.remainingTime--;

    // نبعت لكل الكلينتس التحديث
    io.to(roomId).emit("time-update", {
      remainingTime: room.remainingTime,
    });

    // لو انتهى الوقت
    if (room.remainingTime <= 0) {
      clearInterval(room.timerInterval);
      room.status = "waiting"; // أو 'paused' حتى يضغط الأدمن التالي
      io.to(roomId).emit("time-ended");
      io.to(room.admin).emit("time-ended-admin");
    }
  }, 1000);

  // نبعث أول سؤال مع بيانات الوقت
  io.to(roomId).emit("exam-started", {
    question: room.questions[0],
    index: 0,
    totalQuestions: room.questions.length,
    remainingTime: room.remainingTime,
    qrSize: room.qrSize,
  });

    console.log(`🚀 [START] Exam started in room ${roomId}`);
  });

  // ==== PAUSE & RESUME ====
socket.on("pause-exam", ({ roomId }) => {
  const room = rooms.get(roomId);
  if (!room || room.admin !== socket.id) return;
  room.status = "paused";
  io.to(roomId).emit("exam-paused");
});

socket.on("resume-exam", ({ roomId }) => {
  const room = rooms.get(roomId);
  if (!room || room.admin !== socket.id) return;
  room.status = "active";
  io.to(roomId).emit("exam-resumed");
});
  
  // === Submit Answer ===
  socket.on("submit-answer", ({ roomId, questionId, answer }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const question = room.questions.find((q) => q.id === questionId);
    const team = room.teams.find((t) => t.socketId === socket.id);

    if (!question || !team) return;

    const isCorrect = answer === question.correctAnswer;
    if (isCorrect) {
      team.score += 1;
    }

    socket.emit("answer-result", { correct: isCorrect });
    io.to(room.admin).emit("answer-submitted", {
      teamId: team.id,
      isCorrect,
    });

    console.log(`📩 [ANSWER] Team ${team.name} submitted: ${isCorrect ? "✅" : "❌"}`);
  });

  // === Next Question ===
  socket.on("next-question", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.admin !== socket.id) return;

    clearInterval(room.timerInterval);
    room.currentQuestionIndex++;
    const hasMore = room.currentQuestionIndex < room.questions.length;

    if (hasMore) {
      room.remainingTime = room.timePerQuestion;
      room.status = "active";
      // restart timer
    room.timerInterval = setInterval(() => {
      if (room.status !== "active") return;
      room.remainingTime--;
      io.to(roomId).emit("time-update", { remainingTime: room.remainingTime });
      if (room.remainingTime <= 0) {
        clearInterval(room.timerInterval);
        room.status = "waiting";
        io.to(roomId).emit("time-ended");
        io.to(room.admin).emit("time-ended-admin");
      }
    }, 1000);
      
      io.to(roomId).emit("question", {
        question: room.questions[room.currentQuestionIndex],
        index: room.currentQuestionIndex,
        totalQuestions: room.questions.length,
        timePerQuestion: room.timePerQuestion,
        remainingTime: room.remainingTime,
        qrSize: room.qrSize,
      });
    } else {
      clearInterval(room.timerInterval);
      room.status = "finished";
      io.to(roomId).emit("exam-finished", {
        teams: room.teams,
      });
      console.log(`✅ [FINISH] Exam in room ${roomId}`);
    }
  });
  
  socket.on("pause-exam", ({ roomId }) => {
    io.to(roomId).emit("exam-paused");
  });
  socket.on("resume-exam", ({ roomId }) => {
    io.to(roomId).emit("exam-resumed");
  });

  
  // === Handle Disconnect ===
  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      // Check if admin left
      if (room.admin === socket.id) {
        io.to(roomId).emit("admin-left");
        rooms.delete(roomId);
        console.log(`❌ [ADMIN LEFT] Room ${roomId} closed`);
        break;
      }

      // Check if a team left
      const teamIndex = room.teams.findIndex((t) => t.socketId === socket.id);
      if (teamIndex !== -1) {
        const team = room.teams.splice(teamIndex, 1)[0];
        io.to(room.admin).emit("team-left", team.id);
        console.log(`👋 [LEAVE] Team ${team.name} left room ${roomId}`);
      }
    }
  });
});

// === Server Port ===
const port = process.env.PORT || 3001;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Socket server running on port ${port}`);
});
