const https = require('https');
const SHEETDB_URL = process.env.SHEETDB_URL || 'https://sheetdb.io/api/v1/1xa0d9drrl5r2';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Использование Keep-Alive агента для ускорения сетевых запросов
const keepAliveAgent = new https.Agent({ 
    keepAlive: true, 
    keepAliveMsecs: 5000, 
    maxSockets: 50 
});

let chatHistories = {};
let lastProcessedMessage = new Map();
let lastUpdateId = 0;
const processingChats = new Set(); 

function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanMdToHtml(text) {
    if (!text) return "";
    let safeText = escapeHtml(text);
    const codeBlockRegex = new RegExp('\\x60\\x60\\x60(?:[a-zA-Z]+)?\\n([\\s\\S]*?)\\x60\\x60\\x60', 'g');
    safeText = safeText.replace(codeBlockRegex, '<pre>$1</pre>');
    safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    const inlineCodeRegex = new RegExp('\\x60(.*?)\\x60', 'g');
    safeText = safeText.replace(inlineCodeRegex, '<code>$1</code>');
    return safeText;
}

function makeRequest(url, method = 'POST', headers = {}, body = null, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            agent: keepAliveAgent,
            timeout: timeoutMs,
            headers: { ...headers }
        };

        if (body && method === 'POST') {
            body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = https.request(options, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`API Error: ${res.statusCode}`));
                try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout`)); });
        req.on('error', reject);
        if (body && method === 'POST') req.write(body);
        req.end();
    });
}

async function makeRequestWithRetry(url, method = 'POST', headers = {}, body = null, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try { return await makeRequest(url, method, headers, body); }
        catch (err) { if (i === retries - 1) throw err; await new Promise(res => setTimeout(res, delay)); delay *= 2; }
    }
}

// Получение текста из прикрепленного файла
async function getFileContent(fileId) {
    try {
        const fileInfo = await makeRequestWithRetry(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`, 'GET');
        if (!fileInfo.result?.file_path) return null;
        
        return new Promise((resolve) => {
            https.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', () => resolve(null));
        });
    } catch (e) { return null; }
}

async function sendTypingStatus(chatId) {
    try {
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, 'POST', {}, { chat_id: chatId, action: 'typing' });
    } catch (e) {}
}

async function loadHistoryFromSheet() {
    try {
        const data = await makeRequestWithRetry(`${SHEETDB_URL}?limit=100&sort_by=id&sort_order=desc`, 'GET');
        if (Array.isArray(data)) {
            chatHistories = {};
            data.reverse().forEach(row => {
                if (!row.chatId || !row.role || !row.content) return;
                const role = String(row.role).trim();
                const content = String(row.content).trim();
                if (!role || !content) return;
                if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
                chatHistories[row.chatId].push({ role, content });
            });
            Object.keys(chatHistories).forEach(chatId => {
                if (chatHistories[chatId].length > 20) chatHistories[chatId] = chatHistories[chatId].slice(-20);
            });
        }
    } catch (e) {}
}

async function performSearch(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const html = await makeRequestWithRetry(url, 'GET', { 'User-Agent': 'Mozilla/5.0' });
        if (typeof html !== 'string') return "";
        const snippets = [];
        let match;
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = regex.exec(html)) !== null && snippets.length < 3) {
            const cleanText = match[1].replace(/<[^>]*>/g, '').trim();
            if (cleanText) snippets.push(cleanText);
        }
        return snippets.join(" | ");
    } catch (e) { return ""; }
}

async function handleUpdate(upd) {
    if (!upd.message) return;
    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    
    // Обработка текста или файла
    let txt = upd.message.text || "";
    if (upd.message.document) {
        const fileContent = await getFileContent(upd.message.document.file_id);
        if (fileContent) txt = `[Содержимое файла]:\n${fileContent}\n\n[Вопрос пользователя]: ${txt}`;
    }

    if (!txt) return;
    if (lastProcessedMessage.get(chatId) === msgId) return;
    lastProcessedMessage.set(chatId, msgId);

    if (processingChats.has(chatId)) return;
    processingChats.add(chatId);
    
    if (!chatHistories[chatId]) chatHistories[chatId] = [];
    await sendTypingStatus(chatId);
    const typingInterval = setInterval(() => sendTypingStatus(chatId), 4000);

    let context = "";
    const searchResult = await performSearch(txt);
    if (searchResult) context = `Информация из сети: ${searchResult}\n`;

    try {
        const res = await makeRequestWithRetry('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: `Ты — личный умный помощник Максима. ${context}` },
                ...chatHistories[chatId].slice(-10), 
                { role: 'user', content: txt }
            ]
        });

        clearInterval(typingInterval);
        const aiAnswer = res.choices[0].message.content;
        const reasoning = res.choices[0].message.reasoning_content;

        if (reasoning) {
            await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
                chat_id: chatId, text: `<b>🧠 Мысли:</b>\n<blockquote expandable>${escapeHtml(reasoning)}</blockquote>`, parse_mode: "HTML"
            });
        }
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
            chat_id: chatId, text: cleanMdToHtml(aiAnswer), parse_mode: "HTML"
        });

        chatHistories[chatId].push({ role: 'user', content: txt }, { role: 'assistant', content: aiAnswer });
        makeRequest(SHEETDB_URL, 'POST', {}, { data: [{ chatId, role: 'user', content: txt }, { chatId, role: 'assistant', content: aiAnswer }] }).catch(() => {});
    } catch (e) {
        clearInterval(typingInterval);
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { chat_id: chatId, text: "Ошибка ИИ." });
    } finally {
        processingChats.delete(chatId);
    }
}

async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, 'GET', {}, null, 35000);
        if (res?.ok) {
            for (const u of res.result) { lastUpdateId = u.update_id; await handleUpdate(u); }
        }
    } catch (e) { await new Promise(res => setTimeout(res, 5000)); }
    setTimeout(poll, 1000);
}

loadHistoryFromSheet().then(() => poll());

const server = require('http').createServer((req, res) => res.end('Бот активен!'));
server.listen(process.env.PORT || 3000);
