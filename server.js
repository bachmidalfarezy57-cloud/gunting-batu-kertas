// --- JANTUNG SERVER MULTIPLAYER (Node.js + Socket.io) ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Memberikan izin akses lintas platform (CORS) agar HP luar bisa terhubung
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const rooms = {};

io.on('connection', (socket) => {
    console.log(`User Terkoneksi: ${socket.id}`);

    // 1. EVENT: Player Membuat Room Baru
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase(); // Membuat kode unik 5 digit angka/huruf
        rooms[roomId] = {
            players: [{
                id: socket.id,
                challenge: data.challenge,
                score: 0,
                choice: null,
                isReadyStart: false
            }],
            currentRound: 1,
            timer: 10,
            intervalId: null
        };
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
    });

    // 2. EVENT: Player Lain Join Menggunakan ID Room
    socket.on('joinRoom', (data) => {
        const { roomId, challenge } = data;
        const room = rooms[roomId];

        if (room) {
            if (room.players.length < 2) {
                room.players.push({
                    id: socket.id,
                    challenge: challenge,
                    score: 0,
                    choice: null,
                    isReadyStart: false
                });
                socket.join(roomId);
                io.to(roomId).emit('opponentJoined');
            } else {
                socket.emit('errorMsg', 'Maaf, Room sudah penuh!');
            }
        } else {
            socket.emit('errorMsg', 'ID Room tidak ditemukan!');
        }
    });

    // 3. EVENT: Konfirmasi Tombol "Siap Mulai" di Ruang Tunggu
    socket.on('playerReadyToStart', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isReadyStart = true;

        const allReady = room.players.every(p => p.isReadyStart === true);
        if (room.players.length === 2 && allReady) {
            io.to(data.roomId).emit('gameStarted');
            runRoundEngine(data.roomId);
        } else {
            socket.to(data.roomId).emit('lobbyStatusUpdate', 'Lawan sudah siap, menunggumu menekan tombol Siap Mulai!');
        }
    });

    // 4. EVENT: Menerima Pilihan Tangan Secara Rahasia
    socket.on('makeChoice', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.choice = data.choice;
            // Beritahu visual "SIAP" tanpa membocorkan pilihan tangannya
            io.to(data.roomId).emit('playerReadyVisual', socket.id);
        }

        // Cek jika kedua pemain sudah memilih sebelum timer 10 detik habis
        const bothChosen = room.players.every(p => p.choice !== null);
        if (bothChosen) {
            clearInterval(room.intervalId); // Matikan timer hitung mundur
            evaluateRound(data.roomId);
        }
    });

    // EVENT: Player Putus Koneksi (Keluar Aplikasi)
    socket.on('disconnect', () => {
        console.log(`User Terputus: ${socket.id}`);
        // Hapus room jika salah satu player disconnect demi menghemat memori
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const isInside = room.players.some(p => p.id === socket.id);
            if (isInside) {
                io.to(roomId).emit('errorMsg', 'Lawan keluar dari permainan. Room dibubarkan.');
                clearInterval(room.intervalId);
                delete rooms[roomId];
                break;
            }
        }
    });
});

// ==========================================
//           LOGIKA INTI GAMEPLAY ENGINE
// ==========================================
function runRoundEngine(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Reset pilihan tangan ronde sebelumnya
    room.players.forEach(p => p.choice = null);

    // Beritahu client untuk membuka menu pilih tangan ronde baru
    io.to(roomId).emit('startSelection', room.currentRound);

    room.timer = 10;
    io.to(roomId).emit('timerTick', room.timer);

    clearInterval(room.intervalId);
    room.intervalId = setInterval(() => {
        room.timer--;
        io.to(roomId).emit('timerTick', room.timer);

        if (room.timer <= 0) {
            clearInterval(room.intervalId);
            evaluateRound(roomId); // Evaluasi paksa jika waktu habis (AFK)
        }
    }, 1000);
}

function evaluateRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const p1 = room.players[0];
    const p2 = room.players[1];

    // Jika sampai batas waktu ada yang belum milih (AFK)
    if (!p1.choice) p1.choice = 'afk';
    if (!p2.choice) p2.choice = 'afk';

    let winnerId = 'draw';

    if (p1.choice === p2.choice) {
        winnerId = 'draw';
    } else if (
        (p1.choice === 'batu' && p2.choice === 'gunting') ||
        (p1.choice === 'gunting' && p2.choice === 'kertas') ||
        (p1.choice === 'kertas' && p2.choice === 'batu') ||
        (p2.choice === 'afk' && p1.choice !== 'afk')
    ) {
        p1.score++;
        winnerId = p1.id;
    } else {
        p2.score++;
        winnerId = p2.id;
    }

    // Kirim hasil evaluasi ronde ke kedua HP
    io.to(roomId).emit('roundEvaluated', {
        players: room.players,
        roundWinner: winnerId
    });

    // CEK APAKAH SUDAH ADA YANG MENCAPAI TARGET 5 POIN
    if (p1.score >= 5 || p2.score >= 5) {
        const finalWinner = p1.score >= 5 ? p1 : p2;
        const finalLoser = p1.score >= 5 ? p2 : p1;

        io.to(roomId).emit('gameOver', {
            winnerId: finalWinner.id,
            winnerChallenge: finalWinner.challenge
        });
        
        delete rooms[roomId]; // Hapus data room karena game telah usai
    } else {
        // Jika belum ada yang mengumpulkan 5 poin, lanjut ronde berikutnya dalam 3.5 detik
        room.currentRound++;
        setTimeout(() => {
            runRoundEngine(roomId);
        }, 3500);
    }
}

// Menjalankan server di Port 3000 atau port otomatis hosting
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Mesin Server Game Aktif di Port: ${PORT}`);
});
