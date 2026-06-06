const https = require('https');
const ddg = require('duck-duck-scrape');
const http = require('http');
const cron = require('node-cron');

const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; // твой Telegram ID
const PORT = process.env.PORT || 3000;

// Проверка обязательных переменных
const REQUIRED = { SHEETDB_URL, TELEGRAM_BOT_TOKEN, DEEPSEEK_API_KEY, RENDER_URL, ALLOWED_USER_ID };
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
	console.error(`❌ Не заданы переменные: ${missing.join(', ')}`);
	process.exit(1);
}

const keepAliveAgent = new https.Agent({ keepAlive: true });
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let chatHistories = {};

// 🧠 RAG-lite: факты теперь массив, а не строка
let factsStore = []; // [{ text, ts }]
let historyLoaded = false;

// ─── Форматирование ответа для Telegram ──────────────────────────────────
function escapeHtml(s) {
	return (s || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function formatAiResponse(thinkingText, answerText) {
	let result = '';
	if (thinkingText && thinkingText.trim()) {
		const cleanThinking = escapeHtml(thinkingText.trim());
		result += `🧠 <b>Мысли:</b>\n<blockquote expandable><i>${cleanThinking}</i></blockquote>\n\n`;
	}
	let answer = escapeHtml(answerText)
		.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
		.replace(/`(.*?)`/g, '<code>$1</code>');
	result += answer;
	return result;
}

// Безопасный предпросмотр во время стрима (без markdown→HTML, чтобы не ломать теги)
function formatStreamingPreview(thinkingText, answerText) {
	let out = '';
	if (thinkingText && thinkingText.trim()) {
		out += `🧠 <b>Мысли:</b>\n<blockquote expandable><i>${escapeHtml(thinkingText.trim())}</i></blockquote>\n\n`;
	}
	if (answerText && answerText.trim()) out += escapeHtml(answerText.trim());
	else if (!thinkingText) out += '…';
	return out || '🧠 <i>Думаю…</i>';
}

// ─── HTTP запросы (буферизованные) ────────────────────────────────────────
function makeRequest(url, method = 'POST', headers = {}, body = null) {
	return new Promise((resolve) => {
		let parsedUrl;
		try { parsedUrl = new URL(url); } catch (e) { console.error('Bad URL:', url); return resolve(null); }
		const options = {
			hostname: parsedUrl.hostname,
			path: parsedUrl.pathname + parsedUrl.search,
			method,
			agent: keepAliveAgent,
			headers: { 'Content-Type': 'application/json', ...headers }
		};
		const req = https.request(options, (res) => {
			let buf = '';
			res.on('data', d => buf += d);
			res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); } });
		});
		req.on('error', (e) => { console.error('Request error:', e.message); resolve(null); });
		if (body) req.write(JSON.stringify(body));
		req.end();
	});
}

// ─── DeepSeek: потоковый запрос (stream responses) ────────────────────────
function streamDeepSeek(body, onDelta) {
	return new Promise((resolve) => {
		const url = new URL('https://api.deepseek.com/v1/chat/completions');
		const options = {
			hostname: url.hostname,
			path: url.pathname,
			method: 'POST',
			agent: keepAliveAgent,
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
				'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
			}
		};
		const req = https.request(options, (res) => {
			res.setEncoding('utf8');
			let buffer = '';
			let reasoning = '';
			let answer = '';
			res.on('data', (chunk) => {
				buffer += chunk;
				const lines = buffer.split('\n');
				buffer = lines.pop(); // последняя строка может быть неполной
				for (const line of lines) {
					const s = line.trim();
					if (!s.startsWith('data:')) continue;
					const data = s.slice(5).trim();
					if (!data || data === '[DONE]') continue;
					try {
						const json = JSON.parse(data);
						const delta = json.choices?.[0]?.delta || {};
						let changed = false;
						if (delta.reasoning_content) { reasoning += delta.reasoning_content; changed = true; }
						if (delta.content) { answer += delta.content; changed = true; }
						if (changed && onDelta) onDelta(reasoning, answer);
					} catch (e) { /* пропускаем битый чанк */ }
				}
			});
			res.on('end', () => resolve({ reasoning, answer }));
		});
		req.on('error', (e) => { console.error('Stream error:', e.message); resolve({ reasoning: '', answer: '' }); });
		req.write(JSON.stringify({ ...body, stream: true }));
		req.end();
	});
}

// ─── RAG-lite: лёгкая релевантная выборка фактов (без внешних баз) ─────────
const STOPWORDS = new Set([
	'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так',
	'его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было',
	'вот','от','меня','еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг',
	'ли','если','уже','или','быть','был','него','до','вас','нибудь','опять','уж','вам'
]);

// Грубая нормализация слова (отрезаем частые русские окончания)
function normalizeToken(w) {
	w = w.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
	if (w.length <= 4) return w;
	return w.replace(/(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ам|ям|ой|ей|ую|юю|ие|ые|ий|ый|ая|яя|ть|ешь|ет|ут|ют|ла|ло|ли|на|ка)$/i, '');
}

function tokenize(text) {
	return (text || '')
		.split(/\s+/)
		.map(normalizeToken)
		.filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}

// Заглушка под эмбеддинги: если позже подключишь Pinecone/Redis/OpenAI —
// заменишь только эту функцию и scoreFact на косинусную близость векторов.
function embedText(text) {
	return tokenize(text); // сейчас "вектор" = набор нормализованных токенов
}

function scoreFact(queryTokens, factTokens) {
	if (!queryTokens.length || !factTokens.length) return 0;
	const qset = new Set(queryTokens);
	let overlap = 0;
	for (const t of new Set(factTokens)) if (qset.has(t)) overlap++;
	// нормируем по длине запроса (Jaccard-подобная мера)
	const union = new Set([...queryTokens, ...factTokens]).size;
	return overlap / Math.sqrt(union || 1);
}

// Возвращает только релевантные факты под текущий вопрос
function retrieveRelevantFacts(query, limit = 6) {
	if (!factsStore.length) return '';
	const qTokens = embedText(query);
	const ranked = factsStore
		.map(f => ({ f, score: scoreFact(qTokens, f._tokens || (f._tokens = embedText(f.text))) }))
		.sort((a, b) => b.score - a.score);

	// берём релевантные; если ничего не зацепилось — берём последние добавленные
	let chosen = ranked.filter(r => r.score > 0).slice(0, limit).map(r => r.f.text);
	if (chosen.length === 0) {
		chosen = factsStore.slice(-limit).map(f => f.text);
	}
	return chosen.join(' | ');
}

function addFact(text) {
	const clean = (text || '').trim();
	if (!clean) return false;
	const norm = clean.toLowerCase();
	// дедуп: не добавляем почти-дубликаты
	if (factsStore.some(f => f.text.toLowerCase() === norm)) return false;
	factsStore.push({ text: clean, ts: Date.now(), _tokens: embedText(clean) });
	return true;
}

// ─── Реакции вместо ответа (без затрат токенов) ───────────────────────────
function decideReaction(text) {
	const t = (text || '').toLowerCase().trim();
	if (!t || t.length > 60) return null;          // реагируем только на короткое
	if (t.startsWith('/')) return null;            // команды
	if (/[?？]/.test(t)) return null;              // вопросы — отвечаем текстом
	if (needsSearch(t)) return null;               // просьба найти — отвечаем текстом

	const rules = [
		{ test: /(я дома|дома уже|доехал|добрался|приехал|я на месте|вернулся)/, set: ['👍', '🤗', '❤️'] },
		{ test: /(я рад|рад|ура|круто|здорово|класс|супер|отлично|победа|получилось|сдал|успех|топ)/, set: ['🎉', '🥰', '🔥', '👏', '😍'] },
		{ test: /(люблю|любовь|скучаю|целую|обнимаю)/, set: ['❤️', '😘', '🥰', '❤️‍🔥'] },
		{ test: /(спасибо|благодарю|thx|thanks|пасиб)/, set: ['🙏', '👍', '🤝'] },
		{ test: /(устал|вымотан|спать|сплю|ложусь|выдохся|спокойной ночи)/, set: ['🫡', '😴', '🤝'] },
		{ test: /(грустно|плохо|печаль|расстроен|обидно|болею|заболел)/, set: ['❤️', '😭', '🙏'] },
		{ test: /(смешно|ахах|хаха|лол|ржу|🤣|😂|😅)/, set: ['🤣', '😁'] },
		{ test: /^(ок|окей|окей\.|хорошо|понял|поняла|принято|договорились|ладно|идёт|идет|плюс|\+)$/, set: ['👍', '👌', '🫡'] },
		{ test: /(доброе утро|добрый вечер|добрый день|привет|здарова|хай)/, set: ['🤗', '😁', '👌'] },
		{ test: /(работаю|занят|в пути|еду|выехал|на работе)/, set: ['🫡', '👍', '⚡️'] },
	];

	for (const r of rules) {
		if (r.test.test(t)) return r.set[Math.floor(Math.random() * r.set.length)];
	}
	return null;
}

async function setReaction(chatId, messageId, emoji) {
	return makeRequest(
		`${TG_API}/setMessageReaction`,
		'POST', {},
		{ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }
	);
}

// ─── Поиск через duck-duck-scrape ─────────────────────────────────────────
async function searchWeb(query) {
	try {
		const results = await ddg.search(query, { safeSearch: ddg.SafeSearchType.MODERATE });
		if (!results || !results.results || results.results.length === 0) return null;
		return results.results.slice(0, 4)
			.map(r => `📌 ${r.title}\n${r.description}`)
			.join('\n\n');
	} catch (e) {
		console.error('Search error:', e.message);
		return null;
	}
}

function needsSearch(text) {
	const triggers = [
		'найди', 'поищи', 'погугли', 'что такое', 'кто такой', 'кто такая',
		'расскажи про', 'расскажи о', 'узнай', 'сколько стоит', 'где находится',
		'последние новости', 'новости про', 'что случилось',
		'курс ', 'погода', 'price', 'search', 'find', 'what is', 'who is'
	];
	return triggers.some(t => text.toLowerCase().includes(t));
}

// ─── Notion: создание красивой страницы ───────────────────────────────────
async function formatForNotion(userText) {
	const res = await makeRequest(
		'https://api.deepseek.com/v1/chat/completions',
		'POST',
		{ Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
		{
			model: 'deepseek-chat',
			max_tokens: 1000,
			messages: [
				{
					role: 'system',
					content: `Ты оформляешь заметки для Notion. Получаешь текст от пользователя и возвращаешь ТОЛЬКО валидный JSON без markdown-обёртки. Формат ответа: { "title": "Краткий заголовок страницы", "emoji": "подходящий эмодзи", "blocks": [ { "type": "heading_2", "text": "Раздел" }, { "type": "paragraph", "text": "Текст абзаца" }, { "type": "bulleted_list_item", "text": "Пункт списка" }, { "type": "callout", "text": "Важная заметка", "emoji": "💡" }, { "type": "quote", "text": "Цитата или ключевая мысль" }, { "type": "divider" } ] } Используй разные типы блоков для красивого оформления. Структурируй информацию логично.`
				},
				{ role: 'user', content: userText }
			]
		}
	);

	if (!res?.choices) return null;
	try {
		const raw = res.choices[0].message.content.trim()
			.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
		return JSON.parse(raw);
	} catch (e) {
		console.error('Notion JSON parse error:', e.message);
		return null;
	}
}

function buildNotionBlocks(blocks) {
	return blocks.map(b => {
		const richText = (text) => [{ type: 'text', text: { content: text || '' } }];
		switch (b.type) {
			case 'heading_1':
				return { object: 'block', type: 'heading_1', heading_1: { rich_text: richText(b.text) } };
			case 'heading_2':
				return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(b.text) } };
			case 'heading_3':
				return { object: 'block', type: 'heading_3', heading_3: { rich_text: richText(b.text) } };
			case 'bulleted_list_item':
				return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(b.text) } };
			case 'numbered_list_item':
				return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: richText(b.text) } };
			case 'to_do':
				return { object: 'block', type: 'to_do', to_do: { rich_text: richText(b.text), checked: !!b.checked } };
			case 'callout':
				return { object: 'block', type: 'callout', callout: { rich_text: richText(b.text), icon: { type: 'emoji', emoji: b.emoji || '💡' } } };
			case 'quote':
				return { object: 'block', type: 'quote', quote: { rich_text: richText(b.text) } };
			case 'divider':
				return { object: 'block', type: 'divider', divider: {} };
			default:
				return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(b.text) } };
		}
	});
}

// ─── Форматирование ID в UUID (с дефисами) ───────────────────────────────
function formatNotionId(id) {
	const clean = id.replace(/-/g, '');
	if (clean.length !== 32) return id;
	return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

// ─── Notion: поиск страниц через Search API ──────────────────────────────
async function readNotionPages(query = '') {
	const notionHeaders = {
		'Authorization': `Bearer ${NOTION_TOKEN}`,
		'Notion-Version': '2022-06-28'
	};
	const searchBody = { page_size: 30, filter: { value: 'page', property: 'object' } };
	if (query) searchBody.query = query;

	const result = await makeRequest(
		'https://api.notion.com/v1/search',
		'POST', notionHeaders, searchBody
	);

	if (!result?.results) {
		console.log('Notion search failed:', JSON.stringify(result));
		return [];
	}

	const pages = result.results.map(page => {
		const titleArr = page.properties?.title?.title
			|| page.properties?.Name?.title
			|| page.title
			|| [];
		const title = titleArr.map(t => t.plain_text).join('') || 'Без названия';
		return { id: page.id, title, url: page.url };
	});

	console.log(`Notion search (query="${query}"): найдено ${pages.length} страниц:`, pages.map(p => p.title));
	return pages;
}

// Читаем содержимое страницы — включая вложенные toggle блоки
async function readNotionPageContent(pageId, depth = 0) {
	if (depth > 3) return '';
	const notionHeaders = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' };
	const result = await makeRequest(
		`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
		'GET', notionHeaders
	);
	if (!result?.results) return '';

	const getText = (arr) => arr?.map(t => t.plain_text).join('') || '';
	const indent = '  '.repeat(depth);
	const lines = [];

	for (const block of result.results) {
		let line = '';
		switch (block.type) {
			case 'paragraph':           line = getText(block.paragraph?.rich_text); break;
			case 'heading_1':           line = '# ' + getText(block.heading_1?.rich_text); break;
			case 'heading_2':           line = '## ' + getText(block.heading_2?.rich_text); break;
			case 'heading_3':           line = '### ' + getText(block.heading_3?.rich_text); break;
			case 'bulleted_list_item':  line = '• ' + getText(block.bulleted_list_item?.rich_text); break;
			case 'numbered_list_item':  line = '→ ' + getText(block.numbered_list_item?.rich_text); break;
			case 'callout':             line = '💡 ' + getText(block.callout?.rich_text); break;
			case 'quote':               line = '❝ ' + getText(block.quote?.rich_text); break;
			case 'toggle':              line = '▶ ' + getText(block.toggle?.rich_text); break;
			case 'to_do':               line = (block.to_do?.checked ? '✅' : '☐') + ' ' + getText(block.to_do?.rich_text); break;
			case 'code':                line = getText(block.code?.rich_text); break;
			default: line = '';
		}
		if (line) lines.push(indent + line);

		if (block.has_children) {
			const children = await readNotionPageContent(block.id, depth + 1);
			if (children) lines.push(children);
		}
	}
	return lines.filter(Boolean).join('\n');
}

// ─── Notion: умная логика — читать или писать? ────────────────────────────
const notionLocks = new Set();

async function handleNotion(userText) {
	if (!NOTION_TOKEN || !NOTION_PAGE_ID) {
		return '❌ Notion не настроен. Добавь NOTION_TOKEN и NOTION_PAGE_ID в переменные Render.';
	}

	const lockKey = userText.trim().toLowerCase();
	if (notionLocks.has(lockKey)) {
		console.log('Notion: дубль запроса, игнорирую');
		return '';
	}
	notionLocks.add(lockKey);
	setTimeout(() => notionLocks.delete(lockKey), 30000);

	try {
		const pages = await readNotionPages(userText.replace(/[?？!！]/g, '').trim());
		console.log(`Notion pages found: ${pages.length}`, pages.map(p => p.title));

		const isQuestion = /[?？]/.test(userText) ||
			/^(что|когда|где|как|кто|сколько|почему|зачем|какой|какая|какие|есть ли|покажи|напомни|расскажи)/i.test(userText.trim());

		console.log(`Notion intent: ${isQuestion ? 'ЧИТАТЬ' : 'ВОЗМОЖНО СОЗДАТЬ'}`);

		if (pages.length === 0 && !isQuestion) {
			return await createNotionPage(userText);
		}
		if (pages.length === 0 && isQuestion) {
			return '📭 В Notion пока нет страниц по этой теме.';
		}

		const pagesWithContent = await Promise.all(pages.map(async p => {
			const c = await readNotionPageContent(p.id);
			return { ...p, content: c };
		}));

		const fullContext = pagesWithContent
			.map(p => `=== ${p.title} ===\n${p.content || '(пусто)'}`)
			.join('\n\n');

		const checkRes = await makeRequest(
			'https://api.deepseek.com/v1/chat/completions',
			'POST',
			{ Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
			{
				model: 'deepseek-chat',
				max_tokens: 700,
				messages: [
					{
						role: 'system',
						content: isQuestion
							? `Пользователь задал вопрос про содержимое Notion. Найди ответ в тексте страниц и ответь кратко и понятно. Укажи из какой страницы взял информацию. Если ответа нет — скажи что не нашёл. Отвечай на русском.`
							: `Пользователь хочет что-то записать в Notion. Посмотри есть ли уже страница на эту тему. Если есть — ответь: НАЙДЕНО В: [название страницы] — и кратко что там есть. Если нет — ответь одним словом: СОЗДАТЬ`
					},
					{ role: 'user', content: `Запрос: "${userText}"\n\nСодержимое Notion:\n${fullContext}` }
				]
			}
		);

		const answer = checkRes?.choices?.[0]?.message?.content?.trim() || '';
		console.log('Notion answer:', answer.substring(0, 80));

		if (isQuestion) {
			const pageRef = pagesWithContent.find(p =>
				answer.toLowerCase().includes(p.title.toLowerCase().slice(0, 6))
			);
			const link = pageRef ? `\n\n🔗 ${pageRef.url}` : '';
			return `📖 <b>Notion:</b>\n\n${answer}${link}`;
		}

		if (answer.startsWith('НАЙДЕНО В:')) {
			return `📌 ${answer}\n\nЕсли хочешь всё равно создать новую — напиши точнее что именно записать.`;
		}

		return await createNotionPage(userText);

	} finally {
		notionLocks.delete(lockKey);
	}
}

async function createNotionPage(userText) {
	const formatted = await formatForNotion(userText);
	if (!formatted) return '❌ Не удалось оформить заметку.';

	const pageId = formatNotionId(NOTION_PAGE_ID);
	const result = await makeRequest(
		'https://api.notion.com/v1/pages',
		'POST',
		{ 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
		{
			parent: { page_id: pageId },
			icon: { type: 'emoji', emoji: formatted.emoji || '📝' },
			properties: {
				title: { title: [{ type: 'text', text: { content: formatted.title || 'Заметка' } }] }
			},
			children: buildNotionBlocks(formatted.blocks || [])
		}
	);

	if (result?.id) {
		return `✅ Сохранено в Notion!\n📄 <b>${formatted.title}</b>\n🔗 ${result.url}`;
	}
	const errMsg = result?.message || result?.code || JSON.stringify(result);
	console.error('Notion create error:', errMsg);
	if (errMsg?.includes('object_not_found') || errMsg?.includes('restricted')) {
		return `❌ Нет доступа.\nОткрой страницу в Notion → ... → Connections → добавь интеграцию.`;
	}
	if (errMsg?.includes('Unauthorized') || errMsg?.includes('token')) {
		return `❌ Неверный токен. NOTION_TOKEN должен начинаться с secret_`;
	}
	return `❌ Ошибка Notion: ${errMsg}`;
}

// ─── Shortcut mode: быстрые действия БЕЗ DeepSeek ─────────────────────────
// Добавляем простые блоки прямо на основную страницу Notion (NOTION_PAGE_ID)
async function appendBlocksToMainPage(blocks) {
	if (!NOTION_TOKEN || !NOTION_PAGE_ID) {
		return { ok: false, error: 'Notion не настроен (NOTION_TOKEN / NOTION_PAGE_ID).' };
	}
	const pageId = formatNotionId(NOTION_PAGE_ID);
	const result = await makeRequest(
		`https://api.notion.com/v1/blocks/${pageId}/children`,
		'PATCH',
		{ 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
		{ children: blocks }
	);
	if (result?.results || result?.object === 'list') return { ok: true };
	const errMsg = result?.message || result?.code || JSON.stringify(result);
	return { ok: false, error: errMsg };
}

async function quickAddTodo(text) {
	const res = await appendBlocksToMainPage([
		{ object: 'block', type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked: false } }
	]);
	return res.ok ? `✅ Задача добавлена в Notion:\n☐ ${escapeHtml(text)}` : `❌ Не удалось: ${res.error}`;
}

async function quickAddNote(text) {
	const res = await appendBlocksToMainPage([
		{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }
	]);
	return res.ok ? `✅ Заметка добавлена в Notion:\n📝 ${escapeHtml(text)}` : `❌ Не удалось: ${res.error}`;
}

// ─── Автономные задачи: чтение невыполненных to_do из Notion ──────────────
async function getOpenTodosFromNotion(limit = 15) {
	if (!NOTION_TOKEN || !NOTION_PAGE_ID) return [];
	const pageId = formatNotionId(NOTION_PAGE_ID);
	const content = await readNotionPageContent(pageId);
	if (!content) return [];
	return content
		.split('\n')
		.map(l => l.trim())
		.filter(l => l.startsWith('☐'))
		.map(l => l.replace(/^☐\s*/, ''))
		.filter(Boolean)
		.slice(0, limit);
}

// ─── История из SheetDB ───────────────────────────────────────────────────
async function loadHistoryFromSheet() {
	if (historyLoaded) return;
	console.log('Загружаю историю из SheetDB...');
	const data = await makeRequest(SHEETDB_URL, 'GET');
	if (Array.isArray(data)) {
		data.forEach(row => {
			if (row.chatId && row.role && row.content) {
				if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
				chatHistories[row.chatId].push({ role: row.role, content: row.content });
			}
			if (row.important_fact) addFact(row.important_fact);
		});
		historyLoaded = true;
		console.log(`✅ История загружена. Чатов: ${Object.keys(chatHistories).length}, фактов: ${factsStore.length}`);
	}
}

async function extractImportantFact(userText, aiAnswer) {
	const res = await makeRequest(
		'https://api.deepseek.com/v1/chat/completions',
		'POST',
		{ Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
		{
			model: 'deepseek-chat',
			max_tokens: 80,
			messages: [
				{
					role: 'system',
					content: `Анализируй диалог. Есть ли важная информация о пользователе для постоянного запоминания? Важное: имя, возраст, город, работа, семья, интересы, цели, планы, важные даты, предпочтения. Если есть — напиши ТОЛЬКО краткий факт до 80 символов. Например: "Зовут Максим, 30 лет, живёт в Риме" Если важного нет — ответь одним словом: НЕТ`
				},
				{ role: 'user', content: `Пользователь: ${userText}\nБот: ${aiAnswer.substring(0, 300)}` }
			]
		}
	);
	if (res?.choices) {
		const fact = res.choices[0].message.content.trim();
		if (fact && fact.toUpperCase() !== 'НЕТ' && !fact.toUpperCase().startsWith('НЕТ')) {
			console.log(`💾 Важный факт: ${fact}`);
			return fact;
		}
	}
	return '';
}

async function saveToSheet(chatId, userText, aiAnswer) {
	const importantInfo = await extractImportantFact(userText, aiAnswer);
	if (importantInfo) addFact(importantInfo); // 🧠 кладём в RAG-память
	await makeRequest(SHEETDB_URL, 'POST', {}, {
		data: [
			{ chatId, role: 'user', content: userText },
			{ chatId, role: 'assistant', content: aiAnswer, important_fact: importantInfo }
		]
	});
}

// Ручное сохранение факта (для /facts add) в Sheet
async function saveFactToSheet(fact) {
	await makeRequest(SHEETDB_URL, 'POST', {}, {
		data: [{ chatId: ALLOWED_USER_ID, role: 'system', content: '(manual fact)', important_fact: fact }]
	});
}

// ─── Отправка / редактирование сообщений ──────────────────────────────────
async function sendMessage(chatId, text) {
	let lastId = null;
	for (let i = 0; i < text.length; i += 4000) {
		const r = await makeRequest(
			`${TG_API}/sendMessage`,
			'POST', {},
			{ chat_id: chatId, text: text.slice(i, i + 4000), parse_mode: 'HTML' }
		);
		lastId = r?.result?.message_id || lastId;
	}
	return lastId;
}

async function editMessage(chatId, messageId, text) {
	return makeRequest(
		`${TG_API}/editMessageText`,
		'POST', {},
		{ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }
	);
}

// Финальная сборка: правим плейсхолдер первым куском, остальное — новыми сообщениями
async function finalizeMessage(chatId, messageId, fullText) {
	const chunks = [];
	for (let i = 0; i < fullText.length; i += 4000) chunks.push(fullText.slice(i, i + 4000));
	if (chunks.length === 0) chunks.push('…');
	if (messageId) await editMessage(chatId, messageId, chunks[0]);
	else await sendMessage(chatId, chunks[0]);
	for (let i = 1; i < chunks.length; i++) {
		await makeRequest(`${TG_API}/sendMessage`, 'POST', {}, { chat_id: chatId, text: chunks[i], parse_mode: 'HTML' });
	}
}

// Потоковый ответ с живым редактированием сообщения
async function streamAnswer(chatId, messages) {
	const init = await makeRequest(
		`${TG_API}/sendMessage`,
		'POST', {},
		{ chat_id: chatId, text: '🧠 <i>Думаю…</i>', parse_mode: 'HTML' }
	);
	const messageId = init?.result?.message_id || null;

	let lastEditAt = 0;
	let lastShown = '';

	const tryEdit = async (reasoning, answer) => {
		if (!messageId) return;
		const now = Date.now();
		if (now - lastEditAt < 1500) return; // троттлинг, чтобы не упереться в лимиты Telegram
		let text = formatStreamingPreview(reasoning, answer);
		if (text.length > 4000) text = text.slice(0, 4000) + '…';
		if (text === lastShown) return;
		lastEditAt = now;
		lastShown = text;
		await editMessage(chatId, messageId, text).catch(() => {});
	};

	const { reasoning, answer } = await streamDeepSeek(
		{ model: 'deepseek-reasoner', messages },
		(r, a) => { tryEdit(r, a); }
	);

	return { messageId, reasoning, answer };
}

// ─── Обработка сообщения ──────────────────────────────────────────────────
async function handleUpdate(upd) {
	if (!upd.message || !upd.message.text) return;

	const userId = upd.message.from.id.toString();
	const chatId = upd.message.chat.id.toString();
	const messageId = upd.message.message_id;
	const txt = upd.message.text;

	// 🔒 Проверка доступа — только твой аккаунт
	if (userId !== ALLOWED_USER_ID) {
		console.log(`⛔ Отклонён пользователь: ${userId}`);
		await makeRequest(
			`${TG_API}/sendMessage`,
			'POST', {},
			{ chat_id: chatId, text: '⛔ У тебя нет доступа к этому боту.' }
		);
		return;
	}

	console.log(`[${chatId}] ${txt.substring(0, 60)}`);

	// ⚡️ Реакция вместо ответа — экономим токены (без вызова ИИ)
	if (!txt.startsWith('/')) {
		const emoji = decideReaction(txt);
		if (emoji) {
			console.log(`👍 Реагирую "${emoji}" вместо ответа`);
			await setReaction(chatId, messageId, emoji);
			if (!chatHistories[chatId]) chatHistories[chatId] = [];
			chatHistories[chatId].push({ role: 'user', content: txt });
			return;
		}
	}

	// ⚡️ SHORTCUT MODE — мгновенные действия без DeepSeek ───────────────────
	// /todo Купить молоко
	if (txt.startsWith('/todo ') || txt === '/todo') {
		const t = txt.replace(/^\/todo\s*/i, '').trim();
		if (!t) { await sendMessage(chatId, '✏️ Использование: <code>/todo текст задачи</code>'); return; }
		await sendMessage(chatId, await quickAddTodo(t));
		return;
	}
	// /note быстрый текст
	if (txt.startsWith('/note ') || txt === '/note') {
		const t = txt.replace(/^\/note\s*/i, '').trim();
		if (!t) { await sendMessage(chatId, '✏️ Использование: <code>/note текст заметки</code>'); return; }
		await sendMessage(chatId, await quickAddNote(t));
		return;
	}
	// /facts — посмотреть/добавить факты памяти (без ИИ)
	if (txt === '/facts' || txt.startsWith('/facts ')) {
		const rest = txt.replace(/^\/facts\s*/i, '').trim();
		if (rest.toLowerCase().startsWith('add ')) {
			const fact = rest.slice(4).trim();
			if (addFact(fact)) { await saveFactToSheet(fact).catch(console.error); await sendMessage(chatId, `💾 Факт сохранён:\n${escapeHtml(fact)}`); }
			else await sendMessage(chatId, '⚠️ Пустой или дублирующий факт.');
			return;
		}
		if (!factsStore.length) { await sendMessage(chatId, '🗒 Память пуста.'); return; }
		const list = factsStore.map((f, i) => `${i + 1}. ${escapeHtml(f.text)}`).join('\n');
		await sendMessage(chatId, `🧠 <b>Сохранённые факты (${factsStore.length}):</b>\n\n${list}\n\n➕ Добавить: <code>/facts add текст</code>`);
		return;
	}

	// Показываем "печатает..."
	await makeRequest(
		`${TG_API}/sendChatAction`,
		'POST', {}, { chat_id: chatId, action: 'typing' }
	);

	// 📝 Команда /notion
	if (txt.startsWith('/notion ') || txt.startsWith('/notion\n') || txt === '/notion') {
		const noteText = txt.replace(/^\/notion[\s\n]?/, '').trim();
		if (!noteText) {
			await sendMessage(chatId, '✏️ Напиши тему или текст: <code>/notion твой текст или идея</code>\n\nЯ сам пойму — показать что есть в Notion или записать новое.');
			return;
		}
		await sendMessage(chatId, '🔍 Ищу в Notion...');
		const result = await handleNotion(noteText);
		await sendMessage(chatId, result);
		return;
	}

	// 📖 Команда /help
	if (txt === '/help' || txt === '/start') {
		await sendMessage(chatId,
			`👋 <b>Привет! Вот что я умею:</b>\n\n` +
			`💬 Просто пиши — я отвечу и запомню важное\n` +
			`⚡️ На короткие фразы («я дома», «спасибо») просто ставлю реакцию, не трачу токены\n` +
			`🔍 Попроси найти что-то — поищу в интернете\n` +
			`📝 <code>/notion текст</code> — ищу в Notion или записываю новое (через ИИ-оформление)\n` +
			`⚡️ <code>/todo текст</code> — мгновенно добавить задачу в Notion (без ИИ)\n` +
			`⚡️ <code>/note текст</code> — мгновенно добавить заметку в Notion (без ИИ)\n` +
			`🧠 <code>/facts</code> — память: посмотреть / <code>/facts add текст</code> — добавить\n` +
			`🤖 Сам напомню утром о плане и вечером о задачах из Notion`
		);
		return;
	}

	// Поиск если нужен
	let searchContext = '';
	if (needsSearch(txt)) {
		console.log('Ищу в интернете:', txt);
		const searchResult = await searchWeb(txt);
		if (searchResult) {
			searchContext = `\n\nРезультаты поиска:\n${searchResult}`;
		}
	}

	// 🧠 RAG-lite: подкладываем только релевантные факты под текущий вопрос
	const relevantFacts = retrieveRelevantFacts(txt);

	const messages = [
		{
			role: 'system',
			content: `Ты — умный личный помощник в Telegram. Отвечай на русском языке. Сейчас: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', dateStyle: 'full', timeStyle: 'short' })} Релевантные факты о пользователе (учитывай при ответе): ${relevantFacts || '(нет релевантных)'} ${searchContext ? 'Используй результаты поиска для ответа.' : ''}`
		},
		...(chatHistories[chatId] || []).slice(-10),
		{ role: 'user', content: txt + searchContext }
	];

	// 🔁 Потоковый ответ (stream responses)
	const { messageId: streamMsgId, reasoning, answer } = await streamAnswer(chatId, messages);

	if (answer || reasoning) {
		console.log(`Мысли: ${reasoning.substring(0, 50)}...`);
		console.log(`Ответ: ${answer.substring(0, 50)}...`);

		const formattedAnswer = formatAiResponse(reasoning, answer);

		if (!chatHistories[chatId]) chatHistories[chatId] = [];
		chatHistories[chatId].push({ role: 'user', content: txt });
		chatHistories[chatId].push({ role: 'assistant', content: answer });

		await finalizeMessage(chatId, streamMsgId, formattedAnswer);
		saveToSheet(chatId, txt, answer).catch(console.error);
	} else {
		console.error('DeepSeek ошибка: пустой стрим');
		if (streamMsgId) await editMessage(chatId, streamMsgId, '⚠️ Ошибка AI. Попробуй ещё раз.');
		else await sendMessage(chatId, '⚠️ Ошибка AI. Попробуй ещё раз.');
	}
}

// ─── Автономные задачи (AI Agent через node-cron) ─────────────────────────
function startScheduledTasks() {
	const tz = 'Europe/Chisinau';

	// Доброе утро + план дня (09:00)
	cron.schedule('0 9 * * *', async () => {
		try {
			const todos = await getOpenTodosFromNotion(10);
			const dateStr = new Date().toLocaleString('ru-RU', { timeZone: tz, dateStyle: 'full' });
			let text = `☀️ <b>Доброе утро!</b>\n${escapeHtml(dateStr)}\n\n`;
			if (todos.length) {
				text += `📋 <b>Задачи на сегодня (из Notion):</b>\n` + todos.map(t => `☐ ${escapeHtml(t)}`).join('\n');
			} else {
				text += `📭 Открытых задач в Notion нет. Чистый день 🙌`;
			}
			await sendMessage(ALLOWED_USER_ID, text);
			console.log('🤖 Утреннее сообщение отправлено');
		} catch (e) { console.error('Cron morning error:', e.message); }
	}, { timezone: tz });

	// Вечернее напоминание о незакрытых задачах (19:00)
	cron.schedule('0 19 * * *', async () => {
		try {
			const todos = await getOpenTodosFromNotion(10);
			if (!todos.length) return; // нечего напоминать
			const text = `🌆 <b>Напоминание о задачах</b>\n\nЕщё не закрыто в Notion:\n` +
				todos.map(t => `☐ ${escapeHtml(t)}`).join('\n');
			await sendMessage(ALLOWED_USER_ID, text);
			console.log('🤖 Вечернее напоминание отправлено');
		} catch (e) { console.error('Cron evening error:', e.message); }
	}, { timezone: tz });

	console.log('⏰ Планировщик задач запущен (09:00 утро, 19:00 напоминание)');
}

// ─── Webhook ──────────────────────────────────────────────────────────────
async function setupWebhook() {
	const result = await makeRequest(
		`${TG_API}/setWebhook`,
		'POST', {},
		{
			url: `${RENDER_URL}/webhook/${TELEGRAM_BOT_TOKEN}`,
			allowed_updates: ['message']
		}
	);
	console.log('Webhook:', result?.description || JSON.stringify(result));
}

const server = http.createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Бот активен!');
		return;
	}
	if (req.method === 'POST' && req.url === `/webhook/${TELEGRAM_BOT_TOKEN}`) {
		let body = '';
		req.on('data', chunk => body += chunk);
		req.on('end', async () => {
			res.writeHead(200);
			res.end('OK');
			try { await handleUpdate(JSON.parse(body)); }
			catch (e) { console.error('Webhook parse error:', e.message); }
		});
		return;
	}
	res.writeHead(404);
	res.end('Not found');
});

server.listen(PORT, async () => {
	console.log(`🚀 Сервер на порту ${PORT}`);
	await loadHistoryFromSheet();
	await setupWebhook();
	startScheduledTasks(); // 🤖 автономные задачи
	console.log('✅ Бот готов!');
	startSelfPing();
});

function startSelfPing() {
	setInterval(() => {
		makeRequest(`${RENDER_URL}/`, 'GET')
			.then(() => console.log('✅ Self-ping OK'))
			.catch(() => console.log('⚠️ Self-ping failed'));
	}, 8 * 60 * 1000);
}
