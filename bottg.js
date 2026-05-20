const https = require('https');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb'); // 1. Добавили драйвер

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// 2. Инициализация MongoDB
const client = new MongoClient(process.env.MONGODB_URI);
let db, collection;

client.connect().then(() => {
    db = client.db('botDatabase');
    collection = db.collection('chatHistories');
    console.log("✅ База данных подключена!");
}).catch(e => console.error("❌ Ошибка базы:", e));

// Функции работы с историей
async function getHistory(chatId) {
    if (collection) {
        const res = await collection.findOne({ chatId: chatId });
        return res ? res.history : [];
    }
    return [];
}

async function saveHistory(chatId, history) {
    if (collection) {
        await collection.updateOne({ chatId: chatId }, { $set: { history } }, { upsert: true });
    }
}

function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers }, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function searchWeb(query) {
    try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
        return (await response.text()).substring(0, 3000);
    } catch (e) { return "Ошибка поиска."; }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    try {
        const history = await getHistory(chatId); // Получаем историю из БД

        const checkRes = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-chat',
            messages: [{ role: 'system', content: 'Если вопрос требует поиска, напиши запрос. Если нет — "НЕТ".' }, { role: 'user', content: txt }]
        });

        let searchResult = "";
        const query = checkRes.choices[0].message.content.trim();
        if (query !== "НЕТ" && query.length < 100) searchResult = await searchWeb(query);

        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [{ role: 'system', content: `Контекст: ${searchResult}. Ты — Максим.` }, ...history, { role: 'user', content: txt }]
        });

        const msg = res.choices[0].message;
        let finalMessage = msg.reasoning_content ? `🧠 *Размышления:*\n\n${msg.reasoning_content}\n\n*Ответ:*\n\n${msg.content}` : msg.content;
        
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
            { 'Content-Type': 'application/json' }, 
            { chat_id: chatId, text: finalMessage, parse_mode: "Markdown" });

        history.push({ role: 'user', content: txt });
        history.push({ role: 'assistant', content: finalMessage });
        await saveHistory(chatId, history.slice(-20)); // Сохраняем в БД

    } catch (e) { console.error("Ошибка:", e); }
}

// ... остальной код (poll и сервер) ...
let lastUpdateId = 0;
async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, 'POST', { 'Content-Type': 'application/json' }, { offset: lastUpdateId + 1, timeout: 30 });
        if (res?.ok && res.result.length > 0) {
            lastUpdateId = res.result[res.result.length - 1].update_id;
            for (const u of res.result) await handleUpdate(u);
        }
    } catch (e) {}
    setTimeout(poll, 1000);
}

poll();
require('http').createServer((req, res) => res.end('Бот работает!')).listen(process.env.PORT || 3000);
