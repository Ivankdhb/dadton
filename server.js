const { Telegraf, Markup } = require('telegraf');

// ТОКЕН от @BotFather (замени на свой)
const BOT_TOKEN = '7912345678:AABCdefGHIjklmNOPqrstUvWXyz';

// ССЫЛКА НА ТВОЮ ИГРУ (Render)
const GAME_URL = 'https://dadton.onrender.com';

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
    const userName = ctx.from.first_name || 'игрок';
    
    ctx.replyWithHTML(
        `🚀 <b>Добро пожаловать в DadTon, ${userName}!</b>\n\n` +
        `🎲 Здесь ты можешь играть в захватывающие игры:\n` +
        `• Ракета (краш-игра)\n` +
        `• Рулетка\n` +
        `• Мины 5x5\n` +
        `• Plinko\n` +
        `• Карточная война\n` +
        `• Колесо фортуны\n\n` +
        `⭐ У тебя уже есть 1000 звёзд на старте!\n\n` +
        `👇 Нажми на кнопку ниже, чтобы начать играть!`,
        Markup.inlineKeyboard([
            [Markup.button.webApp('🎮 ЗАПУСТИТЬ ИГРУ', GAME_URL)],
            [Markup.button.url('📢 Наш канал', 'https://t.me/dadton_channel'), Markup.button.url('🆘 Техподдержка', 'https://t.me/dadton_support')],
            [Markup.button.callback('❓ Помощь', 'help')]
        ])
    );
});

bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        `📖 <b>Как играть в DadTon?</b>\n\n` +
        `🎲 <b>Ракета</b>:\n` +
        `1️⃣ Сделай ставку от 10 звёзд\n` +
        `2️⃣ Дождись взлёта ракеты\n` +
        `3️⃣ Забери выигрыш до того, как ракета упадёт!\n\n` +
        `🎡 <b>Рулетка</b>:\n` +
        `• Сделай ставку, у каждого участника шанс выиграть пропорционален ставке\n\n` +
        `💣 <b>Мины</b>:\n` +
        `• Открывай клетки, старайся не попасть на мину\n\n` +
        `⚡ <b>Plinko</b>:\n` +
        `• Запусти шарик и получи множитель\n\n` +
        `🃏 <b>Карточная война</b>:\n` +
        `• Угадай, будет следующая карта больше или меньше\n\n` +
        `🎡 <b>Колесо фортуны</b>:\n` +
        `• Крути и получай случайный множитель\n\n` +
        `⚡ <b>Автовывод</b>:\n` +
        `• Установи множитель, и игра сама заберёт выигрыш\n\n` +
        `💬 По всем вопросам пишите в техподдержку!`,
        { parse_mode: 'HTML' }
    );
});

bot.launch();
console.log('🤖 Бот DadTon запущен!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));