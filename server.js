const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(cors());

const CRYPTOBOT_API_TOKEN = '613177:AAnXuVFE03h7YQGq4NrKRhLIk9I4my6Nms5'; // ВАШ ТОКЕН
const CRYPTOBOT_API_URL = 'https://pay.crypt.bot/api/';

// Прайсы за 1 валидный аккаунт
const PRICES = { telegram: 50, vk: 30, discord: 10, cookie: 1 };

// Временная база данных
const db = {
    users: {},
    getUser(tg_id, name) {
        if (!this.users[tg_id]) {
            this.users[tg_id] = {
                name: name || 'User',
                balance: 0,
                archives_sold: 0,
                total_payout: 0,
                history: [],
                reg_date: new Date().toLocaleDateString('ru-RU')
            };
        }
        return this.users[tg_id];
    }
};

async function cryptoBotRequest(method, params = {}) {
    try {
        const response = await axios.post(CRYPTOBOT_API_URL + method, params, {
            headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_API_TOKEN }
        });
        return response.data;
    } catch (error) {
        console.error('CryptoBot API Error:', error.response?.data || error.message);
        throw error;
    }
}

// 1. Получить данные пользователя
app.get('/api/getMe', (req, res) => {
    const tg_id = req.query.tg_id;
    const name = req.query.name;
    if (!tg_id) return res.status(400).json({ error: 'No tg_id' });
    const user = db.getUser(tg_id, name);
    res.json({ success: true, user });
});

// 2. Продажа аккаунтов (расчет)
app.post('/api/sell', (req, res) => {
    const { tg_id, category, valid_count } = req.body;
    const user = db.getUser(tg_id);
    const price = PRICES[category] || 0;
    const payout = price * valid_count;

    user.balance += payout;
    user.archives_sold += 1;
    user.total_payout += payout;
    user.history.unshift({
        type: 'deposit', amount: payout, date: new Date().toLocaleDateString('ru-RU'), status: 'Выполнено'
    });

    res.json({ success: true, payout, balance: user.balance });
});

// 3. Пополнение
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
        } else {
            res.status(400).json({ error: 'Не удалось создать счет' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 4. Вывод средств
app.post('/api/withdraw', async (req, res) => {
    const { tg_id, asset, amount, address } = req.body;
    const user = db.getUser(tg_id);

    if (user.balance < amount) return res.status(400).json({ error: 'Недостаточно средств' });

    // В реальном проекте здесь бы создавалась заявка на вывод в БД.
    // CryptoBot API не позволяет выводить на произвольные адреса через transfer напрямую без проверки.
    // Для демонстрации мы списываем баланс и записываем в историю.
    console.log(`Заявка на вывод: ${amount} ${asset} на адрес ${address} (User: ${tg_id})`);

    user.balance -= amount;
    user.history.unshift({
        type: 'withdraw', amount: amount, date: new Date().toLocaleDateString('ru-RU'), status: 'В обработке'
    });

    res.json({ success: true, balance: user.balance });
});

// 5. Вебхук
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
        user.history.unshift({
            type: 'deposit', amount: amount, date: new Date().toLocaleDateString('ru-RU'), status: 'Выполнено'
        });
        console.log(`✅ Пополнение: ${tg_id} +${amount}`);
    }
    res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер Skupka запущен на порту ${PORT}`));
