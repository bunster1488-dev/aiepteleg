const https = require('https');
const SHEETDB_URL = 'https://sheetdb.io/api/v1/1xa0d9drrl5r2';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

let chatHistories = {};
let lastProcessedMessage = new Map();

// Универсальный запрос
function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers }, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// УЛУЧШЕННЫЙ ПОИСК: Бот ищет в сети перед ответом
async function performSearch(query) {
    // Используем поиск DuckDuckGo, но просим больше деталей
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`;
    try {
        const res = await makeRequest(url, 'GET');
        return res.AbstractText || res.RelatedTopics?.[0]?.Text || "Ничего не нашлось.";
    } catch (e) { return "Ошибка поиска."; }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    const txt = upd.message.text;

    if (lastProcessedMessage.get(chatId) === msgId) return;
    lastProcessedMessage.set(chatId, msgId);

    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    // 1. Поиск в сети (если вопрос выглядит как запрос знаний)
    let context = "";
    if (txt.length < 100) {
        const searchResult = await performSearch(txt);
        context = `Дополнительная информация из сети: ${searchResult}`;
    }

    // 2. DeepSeek
    try {
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: `Ты — личный помощник Максима. ${context}` },
                ...chatHistories[chatId].slice(-10),
                { role: 'user', content: txt }
            ]
        });

        const finalMessage = res.choices[0].message.content;

        // 3. ОТВЕТ С ЦИТИРОВАНИЕМ
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
            { 'Content-Type': 'application/json' }, 
            { 
                chat_id: chatId, 
                text: finalMessage, 
                parse_mode: "Markdown",
                reply_parameters: { message_id: msgId } // <-- Красивая цитата
            });

        // 4. Сохранение в таблицу
        await makeRequest(SHEETDB_URL, 'POST', { 'Content-Type': 'application/json' }, {
            data: [{ chatId: chatId, role: 'user', content: txt }, { chatId: chatId, role: 'assistant', content: finalMessage }]
        });
        
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: finalMessage });

    } catch (e) { console.error(e); }
}

async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`, 'GET');
        if (res?.result) {
            for (const u of res.result) {
                lastUpdateId = u.update_id;
                await handleUpdate(u);
            }
        }
    } catch (e) {}
    setTimeout(poll, 2000);
}

let lastUpdateId = 0;
poll();
require('http').createServer((req, res) => res.end('Бот живет!')).listen(process.env.PORT || 3000);
