const https = require('https');
const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Бот активен!')).listen(PORT);

const keepAliveAgent = new https.Agent({ keepAlive: true });
let chatHistories = {};
let globalImportantFacts = "";
let lastUpdateId = 0;

function formatAiResponse(text) {
    // Сворачиваем мысли DeepSeek в красивый HTML блок
    let formatted = text.replace(/<think>([\s\S]*?)<\/think>/gi, '<details><summary><b>Подумал...</b></summary><i>$1</i></details>');
    return formatted.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/`(.*?)`/g, '<code>$1</code>');
}

async function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve) => {
        const parsedUrl = new URL(url);
        const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, method: method, agent: keepAliveAgent, headers: { ...headers, 'Content-Type': 'application/json' } };
        const req = https.request(options, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', () => resolve(null));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function loadHistoryFromSheet() {
    const data = await makeRequest(SHEETDB_URL, 'GET');
    if (Array.isArray(data)) {
        let facts = [];
        data.forEach(row => {
            if (row.chatId && row.role && row.content) {
                if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
                chatHistories[row.chatId].push({ role: row.role, content: row.content });
            }
            if (row.important_fact) facts.push(row.important_fact);
        });
        globalImportantFacts = facts.join(" | ");
    }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    await loadHistoryFromSheet();

    const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    }, {
        model: 'deepseek-reasoner',
        messages: [
            { role: 'system', content: `Ты — помощник. Вечные факты: ${globalImportantFacts}` },
            ...(chatHistories[chatId] || []).slice(-10),
            { role: 'user', content: txt }
        ]
    });

    if (res?.choices) {
        const aiAnswer = res.choices[0].message.content;
        const formattedAnswer = formatAiResponse(aiAnswer);
        
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
            chat_id: chatId, text: formattedAnswer, parse_mode: "HTML"
        });

        // Сохраняем историю
        const isImportant = /это важно\.?$/i.test(aiAnswer.trim());
        const importantInfo = isImportant ? aiAnswer.substring(0, 100) : "";
        
        await makeRequest(SHEETDB_URL, 'POST', {}, { data: [
            { chatId: chatId, role: 'user', content: txt }, 
            { chatId: chatId, role: 'assistant', content: aiAnswer, important_fact: importantInfo }
        ]});
    }
}

async function poll() {
    const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`, 'GET');
    if (res?.ok) { for (const u of res.result) { lastUpdateId = u.update_id; await handleUpdate(u); } }
    setTimeout(poll, 1000);
}

loadHistoryFromSheet().then(poll);
