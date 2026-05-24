safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    safeText = safeText.replace(/`(.*?)`/g, '<code>$1</code>');
    return safeText;
}

async function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, method: method, agent: keepAliveAgent, headers: { ...headers } };
        if (body && method === 'POST') {
            body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request(options, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function performSearch(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const html = await makeRequest(url, 'GET', { 'User-Agent': 'Mozilla/5.0' });
        const snippets = [];
        let match, regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = regex.exec(html)) !== null && snippets.length < 3) {
            snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
        }
        return snippets.join(" | ");
    } catch (e) { return ""; }
}

async function getFileContent(fileId) {
    try {
        const fileInfo = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`, 'GET');
        if (!fileInfo.result?.file_path) return null;
        return new Promise((resolve) => {
            https.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => resolve(data));
            }).on('error', () => resolve(null));
        });
    } catch (e) { return null; }
}

async function loadHistoryFromSheet() {
    try {
        const data = await makeRequest(SHEETDB_URL, 'GET');
        if (Array.isArray(data)) {
            let facts = [];
            data.forEach(row => {
                if (row.chatId && row.role && row.content) {
                    if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
                    chatHistories[row.chatId].push({ role: row.role, content: row.content });
                }
                // ИСПРАВЛЕНО: теперь читаем из колонки important_fact (E)
                if (row.important_fact) facts.push(row.important_fact);
            });
            globalImportantFacts = facts.join(" | ");
        }
    } catch (e) { console.error("Ошибка загрузки:", e); }
}

async function handleUpdate(upd) {
    if (!upd.message) return;
    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    let txt = upd.message.text || "";

    if (lastProcessedMessage.get(chatId) === msgId) return;
    lastProcessedMessage.set(chatId, msgId);

    if (upd.message.document) {
        const content = await getFileContent(upd.message.document.file_id);
        if (content) txt = `[Файл]:\n${content}\n\n[Вопрос]: ${txt}`;
    }
    if (!txt) return;

    const searchResult = await performSearch(txt);
    const systemPrompt = `Ты — личный помощник Максима. Вечные факты: ${globalImportantFacts}. Информация из сети: ${searchResult}`;

    try {
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: systemPrompt },
                ...(chatHistories[chatId] || []).slice(-10),
                { role: 'user', content: txt }
            ]
        });

        const aiAnswer = res.choices[0].message.content;
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
            chat_id: chatId, text: cleanMdToHtml(aiAnswer), parse_mode: "HTML", reply_to_message_id: msgId 
        });

        if (!chatHistories[chatId]) chatHistories[chatId] = [];
        chatHistories[chatId].push({ role: 'user', content: txt }, { role: 'assistant', content: aiAnswer });

        const importantInfo = (txt.toLowerCase().includes('запомни') || aiAnswer.toLowerCase().includes('дата')) ? aiAnswer.substring(0, 100) : "";
        
        // ИСПРАВЛЕНО: отправляем в important_fact (колонка E)
        makeRequest(SHEETDB_URL, 'POST', {}, { data: [
            { chatId: chatId, role: 'user', content: txt }, 
            { chatId: chatId, role: 'assistant', content: aiAnswer, important_fact: importantInfo }
        ]});
    } catch (e) { console.error("Ошибка обработки:", e); }
}

async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, 'GET');
        if (res?.ok) { for (const u of res.result) { lastUpdateId = u.update_id; await handleUpdate(u); } }
    } catch (e) {}
    setTimeout(poll, 1000);
}

loadHistoryFromSheet().then(() => poll());
require('http').createServer((req, res) => res.end('Бот активен!')).listen(process.env.PORT || 3000);
