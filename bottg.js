const https = require('https');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const HISTORY_FILE = path.join(__dirname, 'history.json');

let chatHistories = {};
if (fs.existsSync(HISTORY_FILE)) {
    try { chatHistories = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { chatHistories = {}; }
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistories, null, 2));
}

// Функция для HTTP запросов
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

// Функция «ЛУЧШЕГО ПОИСКА» без лишних библиотек
async function duckDuckGoSearch(query) {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_redirect=1&skip_disambig=1`;
    try {
        const data = await makeRequest(url, 'GET', { 'User-Agent': 'Mozilla/5.0' });
        if (data.AbstractText) return `Результат поиска: ${data.AbstractText} (Источник: ${data.AbstractURL})`;
        return "Информации в быстром поиске не найдено, попробуй уточнить запрос.";
    } catch (e) { return "Ошибка поиска."; }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    let systemPrompt = 'Ты — вежливый помощник Максима. Отвечай всегда со смайликами в дружелюбном стиле.';
    let userContent = txt;

    // Автоматический поиск, если Макс просит "найди"
    if (txt.toLowerCase().startsWith('найди ')) {
        const query = txt.substring(6);
        const searchResult = await duckDuckGoSearch(query);
        userContent = `Запрос: "${query}". Данные из интернета: ${searchResult}. Используй это для ответа Максиму.`;
    }

    try {
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: systemPrompt }, 
                ...chatHistories[chatId].slice(-10), 
                { role: 'user', content: userContent }
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
            lastUpdateId = res.result[res.result.length - 1].update_id;
            for (const u of res.result) await handleUpdate(u);
        }
    } catch (e) {}
    setTimeout(poll, 1000);
}

poll();
require('http').createServer((req, res) => res.end('Бот с поиском работает!')).listen(process.env.PORT || 3000);
