const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static('public'));

// ==================== БАЗА ДАННЫХ (ОПТИМИЗИРОВАНА) ====================
const db = new sqlite3.Database('dadton.db');

// Включаем WAL режим для производительности
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 10000');

db.serialize(() => {
    // Пользователи с индексами
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar TEXT,
        stars INTEGER DEFAULT 1000,
        turnover INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        referrer_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_telegram_id ON users(telegram_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_turnover ON users(turnover DESC)`);
    
    // История ракеты
    db.run(`CREATE TABLE IF NOT EXISTS rocket_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        multiplier REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_rocket_timestamp ON rocket_history(timestamp DESC)`);
    
    // Заявки на пополнение
    db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        invoice_id TEXT UNIQUE,
        asset TEXT,
        crypto_amount REAL,
        stars_amount INTEGER,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_invoice_id ON pending_deposits(invoice_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_deposit_status ON pending_deposits(status)`);
    
    // История игр пользователей
    db.run(`CREATE TABLE IF NOT EXISTS user_game_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        game TEXT,
        bet_amount INTEGER,
        win_amount INTEGER,
        multiplier REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_user_history ON user_game_history(telegram_id, timestamp DESC)`);
});

console.log('✅ База данных SQLite оптимизирована и готова');

// ==================== КОНСТАНТЫ ====================
const MAX_BET = 5000;
const MIN_BET = 10;
const MAX_PLAYERS = 500;

// ==================== CRYPTOBOT НАСТРОЙКИ ====================
const CRYPTOBOT_API_KEY = '592213:AAVFSKZYLqO4e4lkOPHWSvC8PCr6RMkYAoH';
const CRYPTOBOT_API_URL = 'https://pay.crypt.bot/api';
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const ADMIN_WALLET = 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';

// Конвертация крипты в звёзды
function convertToStars(asset, amount) {
    if (asset === 'TON') return Math.floor(amount * 100);
    if (asset === 'USDT') return Math.floor(amount * 50);
    return 0;
}

// Создание счёта в CryptoBot
async function createCryptoBotInvoice(asset, amount, telegramId) {
    const starsAmount = convertToStars(asset, amount);
    
    const response = await fetch(`${CRYPTOBOT_API_URL}/createInvoice`, {
        method: 'POST',
        headers: {
            'Crypto-Pay-API-Token': CRYPTOBOT_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            asset: asset,
            amount: amount,
            description: `Пополнение ${starsAmount} звёзд в DadTon`,
            paid_btn_name: 'callback',
            paid_btn_url: `https://t.me/dadton_bot?start=deposit_${telegramId}`
        })
    });
    return await response.json();
}

// Отправка уведомления в Telegram
async function sendTelegramMessage(chatId, message) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
        });
    } catch (err) {
        console.error('Telegram send error:', err);
    }
}

// ==================== API ЭНДПОИНТЫ ====================

// Пополнение - создание счёта
app.post('/api/deposit', async (req, res) => {
    const { telegram_id, asset, cryptoAmount } = req.body;
    
    if (!telegram_id || !asset || !cryptoAmount) {
        return res.json({ success: false, error: 'Не хватает данных' });
    }
    
    if (asset !== 'TON' && asset !== 'USDT') {
        return res.json({ success: false, error: 'Поддерживаются только TON и USDT' });
    }
    
    const minAmount = asset === 'TON' ? 0.5 : 1;
    const maxAmount = asset === 'TON' ? 1000 : 10000;
    
    if (cryptoAmount < minAmount) {
        return res.json({ success: false, error: `Минимум ${minAmount} ${asset}` });
    }
    if (cryptoAmount > maxAmount) {
        return res.json({ success: false, error: `Максимум ${maxAmount} ${asset}` });
    }
    
    const starsAmount = convertToStars(asset, cryptoAmount);
    
    try {
        const invoice = await createCryptoBotInvoice(asset, cryptoAmount, telegram_id);
        
        if (invoice.ok) {
            db.run(`INSERT INTO pending_deposits (telegram_id, invoice_id, asset, crypto_amount, stars_amount, status) 
                    VALUES (?, ?, ?, ?, ?, 'pending')`,
                [telegram_id, invoice.result.invoice_id, asset, cryptoAmount, starsAmount]);
            
            res.json({ 
                success: true, 
                payUrl: invoice.result.pay_url,
                starsAmount: starsAmount,
                cryptoAmount: cryptoAmount,
                asset: asset
            });
        } else {
            res.json({ success: false, error: 'Ошибка платежной системы' });
        }
    } catch (error) {
        console.error('Deposit error:', error);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

// Webhook для CryptoBot
app.post('/webhook/cryptobot', express.json(), async (req, res) => {
    const { invoice_id, status } = req.body;
    
    console.log(`📩 Webhook: invoice ${invoice_id}, status ${status}`);
    
    if (status === 'paid') {
        db.get(`SELECT * FROM pending_deposits WHERE invoice_id = ? AND status = 'pending'`, [invoice_id], async (err, deposit) => {
            if (deposit) {
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ? WHERE telegram_id = ?`, 
                    [deposit.stars_amount, deposit.stars_amount, deposit.telegram_id]);
                db.run(`UPDATE pending_deposits SET status = 'completed' WHERE invoice_id = ?`, [invoice_id]);
                
                await sendTelegramMessage(deposit.telegram_id, 
                    `✅ <b>ПОПОЛНЕНИЕ ВЫПОЛНЕНО!</b>\n\n` +
                    `💵 Оплачено: ${deposit.crypto_amount} ${deposit.asset}\n` +
                    `⭐ Получено: ${deposit.stars_amount} звёзд\n\n` +
                    `💰 Баланс обновлён автоматически`);
                
                console.log(`✅ Начислено ${deposit.stars_amount} звёзд пользователю ${deposit.telegram_id}`);
            }
        });
    }
    
    res.send('OK');
});

// Получение курса
app.get('/api/rates', (req, res) => {
    res.json({
        TON: { stars: 100, minAmount: 0.5, maxAmount: 1000 },
        USDT: { stars: 50, minAmount: 1, maxAmount: 10000 }
    });
});

// ==================== WebSocket ОБРАБОТЧИКИ ====================

let rocketState = {
    status: 'waiting',
    currentMultiplier: 1.00,
    crashPoint: 0,
    bets: [],
    countdown: 10
};

let rocketInterval = null;
let countdownInterval = null;
let minesState = new Map();
let rouletteBets = [];
let rouletteIsSpinning = false;

function generateCrashPoint() {
    let r = Math.random();
    if (r < 0.25) return 1.05 + Math.random() * 0.15;
    if (r < 0.50) return 1.20 + Math.random() * 0.30;
    if (r < 0.70) return 1.50 + Math.random() * 0.50;
    if (r < 0.85) return 2.00 + Math.random() * 1.00;
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
    
    let lastTime = Date.now();
    
    rocketInterval = setInterval(() => {
        if (rocketState.status !== 'flying') {
            clearInterval(rocketInterval);
            return;
        }
        
        const now = Date.now();
        const delta = Math.min(100, now - lastTime);
        lastTime = now;
        
        let speed = rocketState.currentMultiplier < 1.5 ? 0.008 : 0.012 + (rocketState.currentMultiplier - 1.5) * 0.003;
        speed = Math.min(speed, 0.035);
        
        rocketState.currentMultiplier += speed * (delta / 100);
        
        // Автовывод
        for (let bet of rocketState.bets) {
            if (!bet.cashedAt && bet.autoCashout && rocketState.currentMultiplier >= (bet.autoCashout - 0.005)) {
                const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
                bet.cashedAt = rocketState.currentMultiplier;
                bet.winAmount = winAmount;
                
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                    [winAmount, winAmount, bet.telegram_id]);
                
                io.emit('rocket_cashout_done', { 
                    name: bet.name, 
                    multiplier: rocketState.currentMultiplier, 
                    win: winAmount, 
                    amount: bet.amount, 
                    avatar: bet.avatar 
                });
            }
        }
        
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
    }, 50);
}

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
        const telegram_id = data.telegram_id;
        const name = data.name || 'Игрок';
        const avatar = data.avatar || '👤';
        const referrerId = data.referrer_id || null;
        
        if (!telegram_id) {
            if (callback) callback({ success: false, error: 'No telegram_id' });
            return;
        }
        
        db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (err) {
                if (callback) callback({ success: false, error: 'Database error' });
                return;
            }
            
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
        if (!telegram_id) {
            if (callback) callback({ stars: 1000 });
            return;
        }
        
        db.get(`SELECT stars, name, avatar, turnover, games_played, wins FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (row) {
                if (callback) callback({ stars: row.stars, name: row.name, avatar: row.avatar || '👤', turnover: row.turnover || 0, games_played: row.games_played || 0, wins: row.wins || 0 });
            } else {
                if (callback) callback({ stars: 1000 });
            }
        });
    });
    
    socket.on('get_referral_stats', (telegram_id, callback) => {
        if (!telegram_id) {
            if (callback) callback({ count: 0, earned: 0 });
            return;
        }
        
        db.get(`SELECT COUNT(*) as count, SUM(turnover) as total FROM users WHERE referrer_id = ?`, [telegram_id], (err, row) => {
            if (callback) callback({ count: row?.count || 0, earned: Math.floor((row?.total || 0) * 0.1) });
        });
    });
    
    // ===== РАКЕТА =====
    socket.on('rocket_place_bet', (data, callback) => {
        if (!data || !data.telegram_id || rocketState.status !== 'waiting') {
            if (callback) callback({ success: false, error: 'Ставки только до взлёта!' });
            return;
        }
        
        const { telegram_id, name, amount, autoCashout, avatar } = data;
        
        if (amount < MIN_BET || amount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            rocketState.bets.push({
                telegram_id, name, amount, autoCashout: parseFloat(autoCashout) || 0,
                cashedAt: null, winAmount: null, avatar: avatar || '👤'
            });
            
            io.emit('rocket_bet_placed', { name, amount, autoCashout, avatar: avatar || '👤' });
            if (callback) callback({ success: true });
        });
    });
    
    socket.on('rocket_cancel_bet', (data, callback) => {
        if (!data || !data.telegram_id) {
            if (callback) callback({ success: false, error: 'Invalid data' });
            return;
        }
        
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
        if (!data || !data.telegram_id || rocketState.status !== 'flying') {
            if (callback) callback({ success: false, error: 'Сейчас нельзя забрать' });
            return;
        }
        
        const { telegram_id, name } = data;
        const bet = rocketState.bets.find(b => b.telegram_id === telegram_id && !b.cashedAt);
        
        if (!bet || bet.cashedAt) {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
            return;
        }
        
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
    });
    
    socket.on('rocket_get_history', () => {
        db.all(`SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10`, (err, rows) => {
            socket.emit('rocket_history_data', rows || []);
        });
    });
    
    // ===== МИНЫ =====
    socket.on('mines_start', (data, callback) => {
        if (!data || !data.telegram_id) {
            if (callback) callback({ success: false, error: 'Invalid data' });
            return;
        }
        
        const { telegram_id, betAmount, minesCount } = data;
        
        if (betAmount < MIN_BET || betAmount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        if (minesCount < 1 || minesCount > 24) {
            if (callback) callback({ success: false, error: 'Мин от 1 до 24' });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < betAmount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [betAmount, telegram_id]);
            
            const totalCells = 25;
            const mineIndices = [];
            while (mineIndices.length < minesCount) {
                const idx = Math.floor(Math.random() * totalCells);
                if (!mineIndices.includes(idx)) mineIndices.push(idx);
            }
            
            minesState.set(telegram_id, {
                grid: mineIndices,
                bet: betAmount,
                minesCount: minesCount,
                revealed: 0,
                active: true
            });
            
            if (callback) callback({ success: true, minesCount: minesCount });
        });
    });
    
    socket.on('mines_reveal', (data, callback) => {
        if (!data || !data.telegram_id) {
            if (callback) callback({ success: false, error: 'Invalid data' });
            return;
        }
        
        const { telegram_id, cellIndex } = data;
        const game = minesState.get(telegram_id);
        
        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }
        
        if (game.grid.includes(cellIndex)) {
            game.active = false;
            minesState.delete(telegram_id);
            db.run(`UPDATE users SET games_played = games_played - 1 WHERE telegram_id = ?`, [telegram_id]);
            if (callback) callback({ success: false, exploded: true });
            return;
        }
        
        game.revealed++;
        
        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        const multiplier = (safeCells - game.revealed + game.minesCount) / (safeCells - game.revealed);
        const finalMultiplier = Math.min(multiplier, 3.5);
        const winAmount = Math.floor(game.bet * finalMultiplier);
        
        if (callback) callback({ success: true, revealed: game.revealed, multiplier: finalMultiplier.toFixed(2), winAmount });
        
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
        if (!data || !data.telegram_id) {
            if (callback) callback({ success: false, error: 'Invalid data' });
            return;
        }
        
        const { telegram_id } = data;
        const game = minesState.get(telegram_id);
        
        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }
        
        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        const multiplier = (safeCells - game.revealed + game.minesCount) / (safeCells - game.revealed);
        const finalMultiplier = Math.min(multiplier, 3.5);
        const winAmount = Math.floor(game.bet * finalMultiplier);
        
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
    
    // ===== РУЛЕТКА =====
    socket.on('roulette_place_bet', (data, callback) => {
        if (!data || !data.telegram_id || rouletteIsSpinning) {
            if (callback) callback({ success: false, error: 'Рулетка крутится!' });
            return;
        }
        
        const { telegram_id, name, amount, avatar } = data;
        
        if (amount < MIN_BET || amount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        if (rouletteBets.length >= MAX_PLAYERS) {
            if (callback) callback({ success: false, error: 'Достигнут лимит игроков' });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            rouletteBets.push({ telegram_id, name, amount, avatar: avatar || '👤' });
            io.emit('roulette_update', [...rouletteBets]);
            if (callback) callback({ success: true });
        });
    });
    
    socket.on('roulette_cancel_bet', (data, callback) => {
        if (!data || !data.telegram_id) {
            if (callback) callback({ success: false, error: 'Invalid data' });
            return;
        }
        
        const { telegram_id, name } = data;
        const betIndex = rouletteBets.findIndex(b => b.telegram_id === telegram_id);
        
        if (betIndex !== -1) {
            const bet = rouletteBets[betIndex];
            db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [bet.amount, telegram_id]);
            rouletteBets.splice(betIndex, 1);
            io.emit('roulette_update', [...rouletteBets]);
            if (callback) callback({ success: true, amount: bet.amount });
        } else {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
        }
    });
    
    socket.on('roulette_spin', (callback) => {
        if (rouletteIsSpinning) {
            if (callback) callback({ success: false, error: 'Уже крутится!' });
            return;
        }
        
        if (rouletteBets.length < 2) {
            if (callback) callback({ success: false, error: 'Нужно минимум 2 участника!' });
            return;
        }
        
        rouletteIsSpinning = true;
        io.emit('roulette_spinning');
        
        setTimeout(() => {
            const winner = calculateRouletteWinner();
            const total = rouletteBets.reduce((s, b) => s + b.amount, 0);
            const participants = [...rouletteBets];
            
            if (winner) {
                const winAmount = total;
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                    [winAmount, winAmount, winner.telegram_id]);
                
                for (let participant of participants) {
                    if (participant.telegram_id !== winner.telegram_id) {
                        db.get(`SELECT referrer_id FROM users WHERE telegram_id = ?`, [participant.telegram_id], (err, row) => {
                            if (row && row.referrer_id) {
                                const referrerBonus = Math.floor(participant.amount * 0.1);
                                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ? WHERE telegram_id = ?`, 
                                    [referrerBonus, referrerBonus, row.referrer_id]);
                            }
                        });
                    }
                }
                
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
        if (callback) callback([...rouletteBets]);
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
    ╔════════════════════════════════════════════╗
    ║     🚀 DADTON СЕРВЕР ЗАПУЩЕН              ║
    ║     https://dadton.onrender.com           ║
    ║                                          ║
    ║     ⚡ РАКЕТА: активна                   ║
    ║     💣 МИНЫ: активны                     ║
    ║     🎡 РУЛЕТКА: активна                  ║
    ║     💰 ПОПОЛНЕНИЕ: CryptoBot             ║
    ║                                          ║
    ║     МИН СТАВКА: ${MIN_BET}                   ║
    ║     МАКС СТАВКА: ${MAX_BET}                 ║
    ╚════════════════════════════════════════════╝
    `);
});