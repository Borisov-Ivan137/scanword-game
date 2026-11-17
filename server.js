const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Разрешаем подключения с любого устройства
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname)));

const rooms = new Map();

// Настройка подключения к Supabase (ключи берутся из переменных окружения Render)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Функция для генерации кода комнаты
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

io.on('connection', async (socket) => {
    console.log('Новое подключение:', socket.id);

    // При подключении сразу отправляем список сканвордов из базы
    const { data: initialList, error: listError } = await supabase.from('crosswords').select('*');
    if (!listError) socket.emit('crosswordList', initialList || []);

    // Сохранение нового сканворда
    socket.on('saveCustomCrossword', async (data) => {
        const id = "cw_" + Date.now();
        const { error } = await supabase.from('crosswords').insert([{
            id: id,
            name: data.name,
            grid: data.grid,
            words: data.words
        }]);

        if (error) {
            console.error("Ошибка БД при сохранении:", error);
            socket.emit('errorMsg', 'Ошибка сохранения в базу данных');
        } else {
            socket.emit('crosswordSaved', 'Сканворд сохранен в облако!');
            const { data: updatedList } = await supabase.from('crosswords').select('*');
            io.emit('crosswordList', updatedList || []); // Обновляем список у всех
        }
    });

    // Удаление сканворда
    socket.on('deleteCustomCrossword', async (data) => {
        if (data.password === "1234") {
            const { error } = await supabase.from('crosswords').delete().eq('id', data.id);
            if (!error) {
                socket.emit('infoMsg', 'Сканворд удален');
                const { data: updatedList } = await supabase.from('crosswords').select('*');
                io.emit('crosswordList', updatedList || []);
            } else {
                socket.emit('errorMsg', 'Ошибка при удалении');
            }
        } else {
            socket.emit('errorMsg', 'Неверный пароль!');
        }
    });

    // Запуск игры (создание комнаты)
    socket.on('playCustomCrossword', async (data) => {
        const { data: cw, error } = await supabase.from('crosswords').select('*').eq('id', data.id).single();
        
        if (error || !cw) {
            socket.emit('errorMsg', 'Сканворд не найден в базе');
            return;
        }

        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            crossword: cw,
            players: [{ id: socket.id, name: data.playerName }],
            currentState: {},
            chatHistory: []
        });

        socket.join(roomCode);
        socket.emit('gameStarted', {
            roomCode: roomCode,
            crossword: cw,
            currentState: {},
            chatHistory: [],
            players: rooms.get(roomCode).players
        });
    });

    // Подключение к существующей комнате
    socket.on('joinRoom', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms.get(roomCode);
        
        if (!room) {
            socket.emit('errorMsg', 'Комната не найдена или уже закрыта');
            return;
        }
        
        room.players.push({ id: socket.id, name: playerName });
        socket.join(roomCode);
        
        io.to(roomCode).emit('playersUpdated', room.players);
        socket.emit('gameStarted', {
            roomCode: roomCode,
            crossword: room.crossword,
            currentState: room.currentState,
            chatHistory: room.chatHistory,
            players: room.players
        });
    });

    // Ввод букв (синхронизация)
    socket.on('wordInput', (data) => {
        const { roomCode, wordId, inputText, isCompleted } = data;
        const room = rooms.get(roomCode);
        if (!room) return;

        const crosswordWord = room.crossword.words.find(w => w.id === wordId);
        if (!crosswordWord) return;

        const correctAnswer = crosswordWord.answer.toUpperCase();
        let status = 'typing';
        
        if (isCompleted) {
            status = (inputText === correctAnswer) ? 'correct' : 'incorrect';
        }

        room.currentState[wordId] = { text: inputText, status: status };
        io.to(roomCode).emit('wordUpdated', { wordId, state: room.currentState[wordId] });
    });

    // Чат
    socket.on('sendChatMessage', (msg) => {
        const room = rooms.get(msg.roomCode);
        if (room) {
            room.chatHistory.push(msg);
            socket.to(msg.roomCode).emit('receiveChatMessage', msg);
        }
    });

    // Эмодзи
    socket.on('sendEmoji', (data) => {
        socket.to(data.roomCode).emit('receiveEmoji', data);
    });

    // Выход из комнаты
    socket.on('leaveRoom', (roomCode) => {
        const room = rooms.get(roomCode);
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            socket.leave(roomCode);
            if (room.players.length === 0) {
                rooms.delete(roomCode); // Удаляем пустую комнату
            } else {
                io.to(roomCode).emit('playersUpdated', room.players);
            }
        }
    });

    // Отключение (закрытие вкладки)
    socket.on('disconnect', () => {
        rooms.forEach((room, code) => {
            const playerExists = room.players.find(p => p.id === socket.id);
            if (playerExists) {
                room.players = room.players.filter(p => p.id !== socket.id);
                if (room.players.length === 0) {
                    rooms.delete(code);
                } else {
                    io.to(code).emit('playersUpdated', room.players);
                }
            }
        });
    });
});

// Запуск сервера (важно для Render!)
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}`);
});