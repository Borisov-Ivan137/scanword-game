const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // На время тестов можно так. Позже можно заменить на ваш URL с Render
    methods: ["GET", "POST"]
  }
});
app.use(express.static(path.join(__dirname)));

const rooms = new Map();
const DB_FILE = path.join(__dirname, 'crosswords.json');

let savedCrosswords = [];
if (fs.existsSync(DB_FILE)) {
    try {
        savedCrosswords = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Ошибка чтения файла сканвордов:", e);
    }
}

function saveToDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(savedCrosswords, null, 2), 'utf8');
}

io.on('connection', (socket) => {
    socket.emit('crosswordList', savedCrosswords);

    socket.on('createRoom', (data) => {
        const playerName = data.playerName || 'Хост';
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        rooms.set(roomCode, { 
            crossword: data.crossword, 
            players: [{ id: socket.id, name: playerName }], 
            wordsState: {},
            chatHistory: []
        });
        
        socket.join(roomCode);
        
        io.to(roomCode).emit('gameStarted', { 
            roomCode: roomCode, 
            crossword: data.crossword, 
            currentState: {},
            players: rooms.get(roomCode).players,
            chatHistory: []
        });
    });

    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms.get(roomCode);
        
        if (!room) {
            return socket.emit('toastMsg', { text: 'Комната не найдена.', type: 'error' });
        }
        
        if (!room.players.some(p => p.id === socket.id)) {
            room.players.push({ id: socket.id, name: playerName || 'Гость' });
        }
        
        socket.join(roomCode);
        
        socket.emit('gameStarted', { 
            roomCode: roomCode, 
            crossword: room.crossword, 
            currentState: room.wordsState,
            players: room.players,
            chatHistory: room.chatHistory
        });

        io.to(roomCode).emit('playersUpdated', room.players);
    });

    socket.on('leaveRoom', (roomCode) => {
        const room = rooms.get(roomCode);
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            socket.leave(roomCode);
            
            if (room.players.length === 0) {
                rooms.delete(roomCode);
            } else {
                io.to(roomCode).emit('playersUpdated', room.players);
            }
        }
    });

    socket.on('sendChatMessage', (data) => {
        const { roomCode, sender, text } = data;
        const room = rooms.get(roomCode);
        
        if (room && text.trim()) {
            const msg = { sender, text, time: Date.now() };
            room.chatHistory.push(msg);
            io.to(roomCode).emit('receiveChatMessage', msg);
        }
    });

    socket.on('wordInput', (data) => {
        const { roomCode, wordId, inputText, isCompleted } = data;
        const room = rooms.get(roomCode);
        
        if (!room) return;
        if (room.wordsState[wordId] && room.wordsState[wordId].status === 'correct') return;

        if (isCompleted) {
            const wordObj = room.crossword.words.find(w => w.id === wordId);
            const isCorrect = wordObj && (wordObj.answer === inputText.toUpperCase());
            room.wordsState[wordId] = { text: inputText, status: isCorrect ? 'correct' : 'incorrect' };
        } else {
            room.wordsState[wordId] = { text: inputText, status: 'typing' };
        }
        
        io.to(roomCode).emit('wordUpdated', { wordId, state: room.wordsState[wordId] });
    });

    socket.on('sendEmoji', (data) => {
        io.to(data.roomCode).emit('receiveEmoji', { emoji: data.emoji });
    });

    socket.on('saveCustomCrossword', (crosswordData) => {
        try {
            crosswordData.id = 'cw_' + Date.now();
            savedCrosswords.push(crosswordData);
            saveToDB();
            io.emit('crosswordList', savedCrosswords);
            socket.emit('toastMsg', { text: 'Сканворд сохранен!', type: 'success' });
        } catch (error) {
            socket.emit('toastMsg', { text: 'Ошибка сохранения', type: 'error' });
        }
    });

    socket.on('deleteCustomCrossword', (data) => {
        if (data.password !== '1234') {
            return socket.emit('toastMsg', { text: 'Неверный пароль!', type: 'error' });
        }
        
        const index = savedCrosswords.findIndex(c => c.id === data.id);
        if (index !== -1) {
            savedCrosswords.splice(index, 1);
            saveToDB();
            io.emit('crosswordList', savedCrosswords);
            socket.emit('toastMsg', { text: 'Сканворд удален.', type: 'success' });
        }
    });

    // ИСПРАВЛЕННЫЙ ОБРАБОТЧИК ЗАПУСКА ИГРЫ
    socket.on('playCustomCrossword', (data) => {
        const { id, playerName } = data;
        const crossword = savedCrosswords.find(c => c.id === id);
        
        if (!crossword) {
            return socket.emit('toastMsg', { text: 'Сканворд не найден.', type: 'error' });
        }

        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        rooms.set(roomCode, { 
            crossword: { grid: crossword.grid, words: crossword.words }, 
            players: [{ id: socket.id, name: playerName || 'Хост' }], 
            wordsState: {},
            chatHistory: []
        });
        
        socket.join(roomCode);
        
        socket.emit('gameStarted', { 
            roomCode: roomCode, 
            crossword: { grid: crossword.grid, words: crossword.words }, 
            currentState: {},
            players: rooms.get(roomCode).players,
            chatHistory: []
        });
    });
});

// server.js (в самом низу)

const PORT = process.env.PORT || 3000; // Render передаст порт через переменную окружения
server.listen(PORT, '0.0.0.0', () => { // Слушаем на всех интерфейсах
    console.log(`Server started on port ${PORT}`);
});