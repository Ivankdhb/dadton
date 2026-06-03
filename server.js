const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

// Подключение к PostgreSQL (через переменную окружения DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Создание таблиц
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar TEXT,
        stars INTEGER DEFAULT 1000,
        turnover INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0
    )
`).catch(e => console.error('Ошибка создания users:', e.message));

pool.query(`
    CREATE TABLE IF NOT EXISTS rocket_history (
        id SERIAL PRIMARY KEY,
        multiplier REAL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).catch(e => console.error('Ошибка создания rocket_history:', e.message));

console.log('✅ База данных PostgreSQL готова');

// ========== СОСТОЯНИЕ РАКЕТЫ ==========
let rocketState = {
    status: 'waiting',
    currentMultiplier: 1.00,
    crashPoint: 0,
    bets: [],
    countdown: 10
};

let rocketInterval = null;
let countdownInterval = null;

function generateCrashPoint() {
    let r = Math.random();
    if (r < 0.15) return 1.00 + Math.random() * 0.20;
    if (r < 0.40) return 1.20 + Math.random() * 0.60;
    if (r < 0.75) return 1.80 + Math.random() * 1.20;
    if (r < 0.95) return 3.00 + Math.random() * 2.00;
    return 5.00 + Math.random() * 3.00;
}

function startRocketCountdown() {
    rocketState.status = 'waiting';
    rocketState.countdown = 10;
    rocketState.bets = [];

    io.emit('rocket_countdown', rocketState.countdown);
    io.emit('rocket_bets_clear');

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        rocketState.countdown--;
        io.emit('rocket_countdown', rocketState.countdown);
        if (rocketState.countdown <= 0) {
            clearInterval(countdownInterval);
            startRocketFlying();
        }
    }, 1000);
}

function startRocketFlying() {
    let crash = generateCrashPoint();

    rocketState = {
        status: 'flying',
        currentMultiplier: 1.00,
        crashPoint: crash,
        bets: rocketState.bets,
        countdown: 0
    };

    console.log(`🚀 Ракета взлетела! Краш на: ${crash.toFixed(2)}x`);
    io.emit('rocket_start', { crashPoint: crash });

    if (rocketInterval) clearInterval(rocketInterval);

    rocketInterval = setInterval(() => {
        if (rocketState.status !== 'flying') {
            clearInterval(rocketInterval);
            return;
        }

        rocketState.currentMultiplier += 0.02;

        if (rocketState.currentMultiplier >= rocketState.crashPoint) {
            clearInterval(rocketInterval);
            rocketState.status = 'crashed';

            console.log(`💥 КРАШ! ${rocketState.currentMultiplier.toFixed(2)}x`);
            io.emit('rocket_crash', rocketState.currentMultiplier);

            pool.query(`INSERT INTO rocket_history (multiplier) VALUES ($1)`, [rocketState.currentMultiplier]);
            pool.query(`DELETE FROM rocket_history WHERE id NOT IN (SELECT id FROM rocket_history ORDER BY timestamp DESC LIMIT 10)`);

            rocketState.bets.forEach(bet => {
                if (!bet.cashedAt) {
                    pool.query(`UPDATE users SET stars = stars - $1 WHERE telegram_id = $2`, [bet.amount, bet.telegram_id]);
                }
            });

            setTimeout(startRocketCountdown, 1500);
        } else {
            io.emit('rocket_multiplier', rocketState.currentMultiplier);
        }
    }, 100);
}

// ========== МИНЫ ==========
let minesState = new Map();

// ========== РУЛЕТКА ==========
let rouletteBets = [];
let rouletteIsSpinning = false;

function calculateRouletteWinner() {
    let total = rouletteBets.reduce((s, b) => s + b.amount, 0);
    if (total === 0) return null;
    let rand = Math.random() * total;
    let accum = 0;
    for (let bet of rouletteBets) {
        accum += bet.amount;
        if (rand <= accum) return bet;
    }
    return null;
}

// ========== WEB SOCKETS ==========
io.on('connection', (socket) => {
    console.log('👤 Игрок подключился');

    socket.on('register', async (data, callback) => {
        const telegram_id = data.telegram_id || 'player_' + Math.floor(Math.random() * 1000000);
        const name = data.name || 'Игрок';
        const avatar = data.avatar || '👤';

        try {
            const row = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegram_id]);
            if (row.rows.length === 0) {
                await pool.query(`INSERT INTO users (telegram_id, name, avatar, stars) VALUES ($1, $2, $3, 1000)`, [telegram_id, name, avatar]);
                if (callback) callback({ success: true, stars: 1000, name, telegram_id, turnover: 0, games_played: 0, wins: 0 });
            } else {
                const user = row.rows[0];
                if (callback) callback({ success: true, stars: user.stars, name: user.name, telegram_id, turnover: user.turnover || 0, games_played: user.games_played || 0, wins: user.wins || 0 });
            }
        } catch(e) {
            if (callback) callback({ success: false, error: e.message });
        }
    });

    socket.on('get_balance', async (telegram_id, callback) => {
        try {
            const row = await pool.query(`SELECT stars, name, avatar, turnover, games_played, wins FROM users WHERE telegram_id = $1`, [telegram_id]);
            if (row.rows.length > 0) {
                if (callback) callback({ stars: row.rows[0].stars, name: row.rows[0].name, avatar: row.rows[0].avatar, turnover: row.rows[0].turnover || 0, games_played: row.rows[0].games_played || 0, wins: row.rows[0].wins || 0 });
            } else {
                if (callback) callback({ stars: 1000 });
            }
        } catch(e) {
            if (callback) callback({ stars: 1000 });
        }
    });

    // ===== РАКЕТА =====
    socket.on('rocket_place_bet', (data, callback) => {
        if (rocketState.status !== 'waiting') {
            if (callback) callback({ success: false, error: 'Ставки только до взлёта!' });
            return;
        }

        const { telegram_id, name, amount, autoCashout, avatar } = data;

        if (amount < 10) {
            if (callback) callback({ success: false, error: 'Минимум 10 звёзд' });
            return;
        }

        pool.query(`SELECT stars FROM users WHERE telegram_id = $1`, [telegram_id]).then(row => {
            if (!row.rows.length || row.rows[0].stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }

            pool.query(`UPDATE users SET stars = stars - $1 WHERE telegram_id = $2`, [amount, telegram_id]);
            pool.query(`UPDATE users SET games_played = games_played + 1 WHERE telegram_id = $1`, [telegram_id]);

            rocketState.bets.push({
                telegram_id, name, amount, autoCashout,
                cashedAt: null, winAmount: null, avatar: avatar || '👤'
            });

            io.emit('rocket_bet_placed', { name, amount, autoCashout, avatar: avatar || '👤' });
            if (callback) callback({ success: true });
        }).catch(e => {
            if (callback) callback({ success: false, error: e.message });
        });
    });

    socket.on('rocket_cashout', (data, callback) => {
        if (rocketState.status !== 'flying') {
            if (callback) callback({ success: false, error: 'Сейчас нельзя забрать' });
            return;
        }

        const { telegram_id, name } = data;
        const bet = rocketState.bets.find(b => b.telegram_id === telegram_id && !b.cashedAt);

        if (bet) {
            const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
            bet.cashedAt = rocketState.currentMultiplier;
            bet.winAmount = winAmount;

            pool.query(`UPDATE users SET stars = stars + $1, turnover = turnover + $1, wins = wins + 1 WHERE telegram_id = $2`, [winAmount, telegram_id]);

            io.emit('rocket_cashout_done', { name, multiplier: rocketState.currentMultiplier, win: winAmount, amount: bet.amount, avatar: bet.avatar });
            if (callback) callback({ success: true, win: winAmount });
        } else {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
        }
    });

    socket.on('rocket_get_history', async () => {
        const rows = await pool.query(`SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10`);
        socket.emit('rocket_history_data', rows.rows || []);
    });

    // ===== МИНЫ =====
    socket.on('mines_start', (data, callback) => {
        const { telegram_id, betAmount, minesCount } = data;

        if (betAmount < 10) {
            if (callback) callback({ success: false, error: 'Минимум 10 звёзд' });
            return;
        }

        pool.query(`SELECT stars FROM users WHERE telegram_id = $1`, [telegram_id]).then(row => {
            if (!row.rows.length || row.rows[0].stars < betAmount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }

            pool.query(`UPDATE users SET stars = stars - $1 WHERE telegram_id = $2`, [betAmount, telegram_id]);
            pool.query(`UPDATE users SET games_played = games_played + 1 WHERE telegram_id = $1`, [telegram_id]);

            const totalCells = 25;
            let realMinesCount = Math.min(24, minesCount + Math.floor(Math.random() * 4) + 2);
            const mineIndices = [];
            while (mineIndices.length < realMinesCount) {
                const idx = Math.floor(Math.random() * totalCells);
                if (!mineIndices.includes(idx)) mineIndices.push(idx);
            }

            minesState.set(telegram_id, {
                grid: mineIndices,
                bet: betAmount,
                minesCount: realMinesCount,
                revealed: 0,
                active: true
            });

            if (callback) callback({ success: true, minesCount: realMinesCount });
        });
    });

    socket.on('mines_reveal', (data, callback) => {
        const { telegram_id, cellIndex } = data;
        const game = minesState.get(telegram_id);

        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }

        if (game.grid.includes(cellIndex)) {
            game.active = false;
            minesState.delete(telegram_id);
            if (callback) callback({ success: false, exploded: true });
            return;
        }

        game.revealed++;

        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        let multiplier = 1.0;

        for (let i = 0; i < game.revealed; i++) {
            multiplier *= (safeCells - i) / (totalCells - i);
        }
        multiplier = (1 / multiplier) * 0.7;

        const winAmount = Math.floor(game.bet * multiplier);

        if (callback) callback({ success: true, revealed: game.revealed, multiplier: multiplier.toFixed(2), winAmount });

        if (game.revealed === safeCells) {
            pool.query(`UPDATE users SET stars = stars + $1, turnover = turnover + $1, wins = wins + 1 WHERE telegram_id = $2`, [winAmount, telegram_id]);
            game.active = false;
            minesState.delete(telegram_id);
            if (callback) callback({ success: true, finished: true, winAmount });
        }
    });

    socket.on('mines_cashout', (data, callback) => {
        const { telegram_id } = data;
        const game = minesState.get(telegram_id);

        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }

        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        let multiplier = 1.0;

        for (let i = 0; i < game.revealed; i++) {
            multiplier *= (safeCells - i) / (totalCells - i);
        }
        multiplier = (1 / multiplier) * 0.7;

        const winAmount = Math.floor(game.bet * multiplier);

        pool.query(`UPDATE users SET stars = stars + $1, turnover = turnover + $1, wins = wins + 1 WHERE telegram_id = $2`, [winAmount, telegram_id]);

        game.active = false;
        minesState.delete(telegram_id);

        if (callback) callback({ success: true, winAmount });
    });

    // ===== РУЛЕТКА =====
    socket.on('roulette_place_bet', (data, callback) => {
        if (rouletteIsSpinning) {
            if (callback) callback({ success: false, error: 'Рулетка крутится!' });
            return;
        }

        const { telegram_id, name, amount, avatar } = data;

        if (amount < 10) {
            if (callback) callback({ success: false, error: 'Минимум 10 звёзд' });
            return;
        }

        pool.query(`SELECT stars FROM users WHERE telegram_id = $1`, [telegram_id]).then(row => {
            if (!row.rows.length || row.rows[0].stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }

            pool.query(`UPDATE users SET stars = stars - $1 WHERE telegram_id = $2`, [amount, telegram_id]);
            pool.query(`UPDATE users SET games_played = games_played + 1 WHERE telegram_id = $1`, [telegram_id]);

            rouletteBets.push({ telegram_id, name, amount, avatar: avatar || '👤' });
            io.emit('roulette_update', rouletteBets);
            if (callback) callback({ success: true });
        });
    });

    socket.on('roulette_spin', (callback) => {
        if (rouletteIsSpinning) {
            if (callback) callback({ success: false, error: 'Уже крутится!' });
            return;
        }

        if (rouletteBets.length === 0) {
            if (callback) callback({ success: false, error: 'Нет ставок!' });
            return;
        }

        rouletteIsSpinning = true;
        io.emit('roulette_spinning');

        setTimeout(() => {
            const winner = calculateRouletteWinner();
            const total = rouletteBets.reduce((s, b) => s + b.amount, 0);

            if (winner) {
                pool.query(`UPDATE users SET stars = stars + $1, turnover = turnover + $1, wins = wins + 1 WHERE telegram_id = $2`, [total, winner.telegram_id]);
                io.emit('roulette_result', { winner, total });
            } else {
                io.emit('roulette_result', { winner: null, total });
            }

            rouletteBets = [];
            rouletteIsSpinning = false;
            io.emit('roulette_update', []);

            if (callback) callback({ success: true });
        }, 3000);
    });

    socket.on('roulette_get_bets', (callback) => {
        if (callback) callback(rouletteBets);
    });

    socket.on('get_leaderboard', async () => {
        const rows = await pool.query(`SELECT name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50`);
        io.emit('leaderboard_data', rows.rows || []);
    });

    socket.on('disconnect', () => {
        console.log('👋 Игрок отключился');
    });
});

startRocketCountdown();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════╗
    ║   🚀 DADTON СЕРВЕР ЗАПУЩЕН          ║
    ║   http://localhost:${PORT}              ║
    ║   PostgreSQL через Supabase          ║
    ╚══════════════════════════════════════╝
    `);
});