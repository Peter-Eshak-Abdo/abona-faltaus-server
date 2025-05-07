const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const httpServer = createServer(app);

// Enable CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Serve static files if needed
app.use("/public", express.static(path.join(__dirname, "public")));

const io = new Server(httpServer, {
  cors: {
    origin: ["http://localhost:3000", "https://abona-faltaus.vercel.app", "https://exam-group.glitch.me"],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  socket.on("create-room", ({ roomId }) => {
    rooms.set(roomId, {
      teams: [],
      admin: socket.id,
      status: "waiting",
      questions: [],
      currentQuestionIndex: 0,
    });
    socket.join(roomId);
    console.log(`Room ${roomId} created by admin ${socket.id}`);
  });

  socket.on("join-room", ({ roomId, team, isAdmin }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("room-error", "الغرفة غير موجودة");
      return;
    }

    if (isAdmin) {
      if (room.admin === socket.id) {
        socket.join(roomId);
        socket.emit("room-joined", { isAdmin: true });
        if (room.status === "active" && room.questions.length > 0) {
          socket.emit("exam-started", {
            question: room.questions[room.currentQuestionIndex],
            timePerQuestion: room.timePerQuestion,
            totalQuestions: room.questions.length,
          });
        }
      }
      return;
    }

    const existingTeam = room.teams.find((t) => t.id === team.id);
    if (!existingTeam) {
  room.teams.push({
    id: team.id,
    name: team.name,
    socketId: socket.id,
    score: 0,
    memberCount: team.memberCount, // أضف هذا السطر
    members: team.members || [],   // وأيضًا هذا السطر
  });
  socket.join(roomId);
  socket.emit("room-joined", { team });
  io.to(room.admin).emit("team-joined", team);
  console.log(`Team ${team.name} joined room ${roomId}`);
} else {
  existingTeam.socketId = socket.id;
  socket.join(roomId);
  socket.emit("room-joined", { team: existingTeam });
  console.log(`Team ${existingTeam.name} reconnected to room ${roomId}`);
}
  });

  socket.on("start-exam", ({ roomId, settings }) => {
    const room = rooms.get(roomId);
    if (room && room.admin === socket.id) {
      room.status = "active";

      const questionsPath = path.join(__dirname, "public", "exam", "simple.json");
      const questionsData = JSON.parse(fs.readFileSync(questionsPath, "utf8"));

      let allQuestions = [];
      settings.categories.forEach((category) => {
        const categoryData = questionsData.find((cat) => cat.category === category);
        if (categoryData) {
          allQuestions = allQuestions.concat(categoryData.questions);
        }
      });

      const shuffledQuestions = allQuestions
        .sort(() => Math.random() - 0.5)
        .slice(0, settings.questionCount);

      room.questions = shuffledQuestions;
      room.currentQuestionIndex = 0;
      room.timePerQuestion = settings.timePerQuestion;

      io.to(roomId).emit("exam-started", {
        question: room.questions[0],
        timePerQuestion: settings.timePerQuestion,
        totalQuestions: settings.questionCount,
      });

      console.log(`Exam started in room ${roomId}`);
    }
  });

  socket.on("disconnect", () => {
    rooms.forEach((room, roomId) => {
      const teamIndex = room.teams.findIndex((t) => t.socketId === socket.id);
      if (teamIndex !== -1) {
        const team = room.teams[teamIndex];
        room.teams.splice(teamIndex, 1);
        io.to(room.admin).emit("team-left", team.id);
        console.log(`Team ${team.name} left room ${roomId}`);
      }
    });
  });

  socket.on("next-question", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.admin === socket.id) {
      room.currentQuestionIndex++;
      if (room.currentQuestionIndex < room.questions.length) {
        const question = room.questions[room.currentQuestionIndex];
        io.to(roomId).emit("question", question);
      } else {
        room.status = "finished";
        io.to(roomId).emit("exam-finished", {
          teams: room.teams,
        });
      }
    }
  });

  socket.on("submit-answer", ({ roomId, questionId, answer }) => {
    const room = rooms.get(roomId);
    if (room) {
      const question = room.questions.find((q) => q.id === questionId);
      if (question) {
        const isCorrect = answer === question.correctAnswer;
        const team = room.teams.find((t) => t.socketId === socket.id);
        if (team) {
          if (isCorrect) {
            team.score += 1;
          }
          socket.emit("answer-result", { correct: isCorrect });
          io.to(room.admin).emit("answer-submitted", {
            teamId: team.id,
            isCorrect,
          });
        }
      }
    }
  });
});

// Listen on port
const port = process.env.PORT || 3001;
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Socket server running on port ${port}`);
});
