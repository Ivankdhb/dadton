const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('dadton.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar TEXT,
        stars INTEGER DEFAULT 1000,
        turnover INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        referrer_id TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rocket_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        multiplier REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

console.log('✅ База данных SQLite готова');

let rocketState = {
    status: 'waiting',
    currentMultiplier: 1.00,
    crashPoint: 0,
    bets: [],
    countdown: 10
};

let rocketInterval = null;
let countdownInterval = null;

// РАЗНООБРАЗНЫЕ ИКСЫ (от 1.05 до 5.00+)
function generateCrashPoint() {
    let r = Math.random();
    // 25% — маленькие иксы (1.05 - 1.20)
    if (r < 0.25) return 1.05 + Math.random() * 0.15;
    // 25% — средние (1.20 - 1.50)
    if (r < 0.50) return 1.20 + Math.random() * 0.30;
    // 20% — хорошие (1.50 - 2.00)
    if (r < 0.70) return 1.50 + Math.random() * 0.50;
    // 15% — высокие (2.00 - 3.00)
    if (r < 0.85) return 2.00 + Math.random() * 1.00;
    // 10% — очень высокие (3.00 - 5.00)
    if (r < 0.95) return 3.00 + Math.random() * 2.00;
    // 5% — экстрим (5.00 - 8.00)
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
        
        rocketState.currentMultiplier += 0.01;
        
        if (rocketState.currentMultiplier >= rocketState.crashPoint) {
            clearInterval(rocketInterval);
            rocketState.status = 'crashed';
            
            console.log(`💥 КРАШ! ${rocketState.currentMultiplier.toFixed(2)}x`);
            io.emit('rocket_crash', rocketState.currentMultiplier);
            
            db.run(`INSERT INTO rocket_history (multiplier) VALUES (?)`, [rocketState.currentMultiplier]);
            
            setTimeout(startRocketCountdown, 1500);
        } else {
            io.emit('rocket_multiplier', rocketState.currentMultiplier);
        }
    }, 100);
}

let minesState = new Map();
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

io.on('connection', (socket) => {
    console.log('👤 Игрок подключился');
    
    socket.on('register', (data, callback) => {
        const telegram_id = data.telegram_id || 'player_' + Math.floor(Math.random() * 1000000);
        const name = data.name || 'Игрок';
        const avatar = data.avatar || '👤';
        const referrerId = data.referrer_id || null;
        
        db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO users (telegram_id, name, avatar, stars, referrer_id) VALUES (?, ?, ?, 1000, ?)`, 
                    [telegram_id, name, avatar, referrerId], function(err) {
                    if (err) {
                        if (callback) callback({ success: false, error: err.message });
                    } else {
                        if (referrerId) {
                            db.run(`UPDATE users SET stars = stars + 100 WHERE telegram_id = ?`, [referrerId]);
                        }
                        if (callback) callback({ success: true, stars: 1000, name, telegram_id, avatar, turnover: 0, games_played: 0, wins: 0 });
                    }
                });
            } else {
                if (callback) callback({ success: true, stars: row.stars, name: row.name, telegram_id, avatar: row.avatar || '👤', turnover: row.turnover || 0, games_played: row.games_played || 0, wins: row.wins || 0 });
            }
        });
    });
    
    socket.on('get_balance', (telegram_id, callback) => {
        db.get(`SELECT stars, name, avatar, turnover, games_played, wins FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (row) {
                if (callback) callback({ stars: row.stars, name: row.name, avatar: row.avatar || '👤', turnover: row.turnover || 0, games_played: row.games_played || 0, wins: row.wins || 0 });
            } else {
                if (callback) callback({ stars: 1000 });
            }
        });
    });
    
    socket.on('get_referral_stats', (telegram_id, callback) => {
        db.get(`SELECT COUNT(*) as count, SUM(turnover) as total FROM users WHERE referrer_id = ?`, [telegram_id], (err, row) => {
            if (callback) callback({ count: row?.count || 0, earned: Math.floor((row?.total || 0) * 0.1) });
        });
    });
    
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
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            rocketState.bets.push({
                telegram_id, name, amount, autoCashout,
                cashedAt: null, winAmount: null, avatar: avatar || '👤'
            });
            
            io.emit('rocket_bet_placed', { name, amount, autoCashout, avatar: avatar || '👤' });
            if (callback) callback({ success: true });
        });
    });
    
    socket.on('rocket_cancel_bet', (data, callback) => {
        const { telegram_id } = data;
        
        const betIndex = rocketState.bets.findIndex(b => b.telegram_id === telegram_id && !b.cashedAt);
        
        if (betIndex === -1) {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
            return;
        }
        
        const bet = rocketState.bets[betIndex];
        
        db.run(`UPDATE users SET stars = stars + ?, games_played = games_played - 1 WHERE telegram_id = ?`, [bet.amount, telegram_id]);
        
        rocketState.bets.splice(betIndex, 1);
        
        io.emit('rocket_bet_cancelled', { telegram_id, name: bet.name });
        
        if (callback) callback({ success: true, amount: bet.amount });
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
            
            db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                [winAmount, winAmount, telegram_id]);
            
            db.get(`SELECT referrer_id FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
                if (row && row.referrer_id) {
                    const referrerBonus = Math.floor(winAmount * 0.1);
                    db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ? WHERE telegram_id = ?`, 
                        [referrerBonus, referrerBonus, row.referrer_id]);
                }
            });
            
            io.emit('rocket_cashout_done', { name, multiplier: rocketState.currentMultiplier, win: winAmount, amount: bet.amount, avatar: bet.avatar });
            if (callback) callback({ success: true, win: winAmount });
        } else {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
        }
    });
    
    socket.on('rocket_get_history', () => {
        db.all(`SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10`, (err, rows) => {
            socket.emit('rocket_history_data', rows || []);
        });
    });
    
    socket.on('mines_start', (data, callback) => {
        const { telegram_id, betAmount, minesCount } = data;
        
        if (betAmount < 10) {
            if (callback) callback({ success: false, error: 'Минимум 10 звёзд' });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < betAmount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [betAmount, telegram_id]);
            
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
            db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                [winAmount, winAmount, telegram_id]);
            
            db.get(`SELECT referrer_id FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
                if (row && row.referrer_id) {
                    const referrerBonus = Math.floor(winAmount * 0.1);
                    db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ? WHERE telegram_id = ?`, 
                        [referrerBonus, referrerBonus, row.referrer_id]);
                }
            });
            
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
        
        db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
            [winAmount, winAmount, telegram_id]);
        
        db.get(`SELECT referrer_id FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (row && row.referrer_id) {
                const referrerBonus = Math.floor(winAmount * 0.1);
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ? WHERE telegram_id = ?`, 
                    [referrerBonus, referrerBonus, row.referrer_id]);
            }
        });
        
        game.active = false;
        minesState.delete(telegram_id);
        
        if (callback) callback({ success: true, winAmount });
    });
    
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
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
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
                const winAmount = total;
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                    [winAmount, winAmount, winner.telegram_id]);
                
                db.get(`SELECT referrer_id FROM users WHERE telegram_id = ?`, [winner.telegram_id], (err, row) => {
                    if (row && row.referrer_id) {
                        const referrerBonus = Math.floor(winAmount * 0.1);
                        db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ? WHERE telegram_id = ?`, 
                            [referrerBonus, referrerBonus, row.referrer_id]);
                    }
                });
                
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
    
    socket.on('get_leaderboard', () => {
        db.all(`SELECT name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50`, (err, rows) => {
            io.emit('leaderboard_data', rows || []);
        });
    });
    
    socket.on('disconnect', () => {
        console.log('👋 Игрок отключился');
    });
});

startRocketCountdown();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════╗
    ║   🚀 DADTON СЕРВЕР ЗАПУЩЕН          ║
    ║   http://localhost:${PORT}              ║
    ║                                      ║
    ║   📊 ИКСЫ: разнообразные             ║
    ║   - 25%: 1.05-1.20x                 ║
    ║   - 25%: 1.20-1.50x                 ║
    ║   - 20%: 1.50-2.00x                 ║
    ║   - 15%: 2.00-3.00x                 ║
    ║   - 10%: 3.00-5.00x                 ║
    ║   - 5%:  5.00-8.00x                 ║
    ╚══════════════════════════════════════╝
    `);
});