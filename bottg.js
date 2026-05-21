const https = require('https');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const HISTORY_FILE = path.join(__dirname, 'history.json');

let chatHistories = {};
let processedUpdates = new Set();

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
        return data.AbstractText ? `Информация из сети: ${data.AbstractText}` : "Нет свежих данных в сети.";
    } catch (e) { return "Ошибка поиска."; }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    // Бот сам решает, нужен ли интернет
    let finalContent = txt;
    if (txt.length < 50) { // Если запрос короткий, проверяем, нужен ли поиск
        const searchRes = await duckDuckGoSearch(txt);
        finalContent = `Запрос: "${txt}".\n${searchRes}\n\nОтветь на вопрос, перефразировав его для ясности.`;
    }

    try {
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: 'Ты — умный помощник Максима. Анализируй запрос: если нужно — ищи в сети, если нет — отвечай своими знаниями. Всегда перефразируй ответ для лучшего понимания. Используй дружелюбный тон и эмодзи.' }, 
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

let lastUpdateId = 0;
async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, 'POST', { 'Content-Type': 'application/json' }, { offset: lastUpdateId + 1, timeout: 30 });
        if (res?.ok && res.result.length > 0) {
            for (const u of res.result) {
                if (!processedUpdates.has(u.update_id)) {
                    processedUpdates.add(u.update_id);
                    lastUpdateId = u.update_id;
                    await handleUpdate(u);
                    setTimeout(() => processedUpdates.delete(u.update_id), 60000);
                }
            }
        }
    } catch (e) {}
    setTimeout(poll, 1000);
}

poll();
require('http').createServer((req, res) => res.end('Бот готов к работе!')).listen(process.env.PORT || 3000);
