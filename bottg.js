const https = require('https');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const HISTORY_FILE = path.join(__dirname, 'history.json');

let chatHistories = {};
let processedUpdates = new Set();
let lastProcessedMessage = new Map(); // Защита от дублей

if (fs.existsSync(HISTORY_FILE)) {
    try { chatHistories = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { chatHistories = {}; }
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistories, null, 2));
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

async function duckDuckGoSearch(query) {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_redirect=1&skip_disambig=1`;
    try {
        const data = await makeRequest(url, 'GET', { 'User-Agent': 'Mozilla/5.0' });
        return data.AbstractText ? `Информация из сети: ${data.AbstractText}` : "";
    } catch (e) { return ""; }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    const txt = upd.message.text;

    // Защита от двойного ответа
    if (lastProcessedMessage.get(chatId) === msgId) return;
    lastProcessedMessage.set(chatId, msgId);

    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    let finalContent = txt;
    // Поиск включается только если запрос короткий и выглядит как вопрос
    if (txt.length < 50) {
        const searchRes = await duckDuckGoSearch(txt);
        if (searchRes) finalContent = `Запрос: "${txt}".\n${searchRes}\n\nОтветь на основе данных, перефразируй для ясности.`;
    }

    try {
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: 'Ты — умный помощник. Используй данные поиска, если они есть. Всегда отвечай дружелюбно, со смайликами и перефразируй ответ для лучшего понимания.' }, 
                ...chatHistories[chatId].slice(-10), 
                { role: 'user', content: finalContent }
            ]
        });

        const msg = res.choices[0].message;
        let finalMessage = msg.reasoning_content ? `🧠 *Размышления:*\n\n${msg.reasoning_content}\n\n*Ответ:*\n\n${msg.content}` : msg.content;

        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
            { 'Content-Type': 'application/json' }, 
            { chat_id: chatId, text: finalMessage, parse_mode: "Markdown" });

        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: finalMessage });
        if (chatHistories[chatId].length > 20) chatHistories[chatId] = chatHistories[chatId].slice(-20);
        saveHistory();
    } catch (e) { console.error("Ошибка:", e); }
}

async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, 'POST', { 'Content-Type': 'application/json' }, { offset: lastUpdateId + 1, timeout: 30 });
        if (res?.ok && res.result.length > 0) {
            for (const u of res.result) {
                lastUpdateId = u.update_id;
                await handleUpdate(u);
            }
        }
    } catch (e) {}
    setTimeout(poll, 2000); // Увеличили паузу до 2 секунд для стабильности
}

let lastUpdateId = 0;
poll();
require('http').createServer((req, res) => res.end('Бот работает стабильно!')).listen(process.env.PORT || 3000);
