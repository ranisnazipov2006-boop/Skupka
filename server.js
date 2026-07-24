const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// Настройка для правильной проверки подписи CryptoBot
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(cors());

// === ВАШИ НАСТРОЙКИ ===
const CRYPTOBOT_API_TOKEN = '613177:AAnXuVFE03h7YQGq4NrKRhLIk9I4my6Nms5'; // Вставьте ваш токен
const CRYPTOBOT_API_URL = 'https://pay.crypt.bot/api/';

// Временная база данных
let usersBalance = { "12345678": 100 };
let usersWithdrawals = {};

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

// 1. ВЫВОД СРЕДСТВ
app.post('/api/withdraw', async (req, res) => {
    const { tg_id, amount } = req.body;

    if (!tg_id || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Неверные данные' });
    }

    if ((usersBalance[tg_id] || 0) < amount) {
        return res.status(400).json({ error: 'Недостаточно средств на балансе' });
    }

    const spendId = `withdraw_${tg_id}_${Date.now()}`;
    if (usersWithdrawals[spendId]) return res.status(400).json({ error: 'Заявка уже обрабатывается' });
    usersWithdrawals[spendId] = true;

    try {
        usersBalance[tg_id] -= amount; // Списываем

        const cryptoResponse = await cryptoBotRequest('transfer', {
            user_id: tg_id,
            asset: 'USDT',
            amount: amount,
            spend_id: spendId,
            comment: 'Вывод средств с Skupka.com'
        });

        if (cryptoResponse.ok) {
            res.json({ success: true });
        } else {
            usersBalance[tg_id] += amount; // Возврат
            delete usersWithdrawals[spendId];
            res.status(400).json({ error: 'Ошибка CryptoBot: ' + (cryptoResponse.error || 'Неизвестная') });
        }
    } catch (error) {
        usersBalance[tg_id] += amount;
        delete usersWithdrawals[spendId];
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// 2. ПОПОЛНЕНИЕ
app.post('/api/deposit', async (req, res) => {
    const { tg_id, amount } = req.body;

    try {
        const cryptoResponse = await cryptoBotRequest('createInvoice', {
            asset: 'USDT',
            amount: amount,
            description: 'Пополнение баланса Skupka.com',
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

// 3. ВЕБХУК ДЛЯ АВТО-ПОПОЛНЕНИЯ
app.post('/api/webhook', (req, res) => {
    // Проверка подписи CryptoBot
    const secret = crypto.createHash('sha256').update(CRYPTOBOT_API_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    
    if (hmac !== req.headers['crypto-pay-api-signature']) {
        return res.status(401).send('Unauthorized');
    }

    const update = req.body;
    
    // Если счет оплачен
    if (update.update_type === 'invoice_paid') {
        const payload = JSON.parse(update.payload.invoice.payload);
        const tg_id = payload.tg_id;
        const amount = parseFloat(update.payload.invoice.amount);

        // Начисляем деньги
        usersBalance[tg_id] = (usersBalance[tg_id] || 0) + amount;
        console.log(`✅ Пользователь ${tg_id} пополнил на ${amount} USDT`);
    }
    
    res.send('OK'); // Обязательно отвечаем 200 OK
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер Skupka запущен на порту ${PORT}`));
