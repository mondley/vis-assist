const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — memory disabled, running in-memory only');
    return;
  }
  const maxRetries = 10;
  const retryDelayMs = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          description TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          source TEXT DEFAULT 'voice',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('DB ready — memory enabled');
      return;
    } catch (err) {
      console.error(`DB init attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) {
        console.error('DB init gave up after max retries — memory may be degraded until DB recovers');
        return;
      }
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
}
initDB();

// ── GET HISTORY ──────────────────────────────────────
app.get('/api/history', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ messages: [] });
  try {
    const result = await pool.query(
      'SELECT role, content FROM messages ORDER BY id ASC LIMIT 100'
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error('History fetch error:', err.message);
    res.status(503).json({ error: err.message, messages: [] });
  }
});

// ── CLEAR HISTORY ────────────────────────────────────
app.delete('/api/history', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ ok: true });
  try {
    await pool.query('DELETE FROM messages');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SAVE MESSAGE ─────────────────────────────────────
async function saveMessage(role, content) {
  if (!process.env.DATABASE_URL) return;
  try {
    await pool.query('INSERT INTO messages (role, content) VALUES ($1, $2)', [role, content]);
  } catch (err) {
    console.error('Save message error:', err.message);
  }
}

// ── TASKS ─────────────────────────────────────────────
async function saveTask(description, source = 'voice') {
  if (!process.env.DATABASE_URL) return null;
  try {
    const result = await pool.query(
      'INSERT INTO tasks (description, source) VALUES ($1, $2) RETURNING *',
      [description, source]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Save task error:', err.message);
    return null;
  }
}

app.get('/api/tasks', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json({ tasks: [] });
  try {
    const { status } = req.query;
    const result = status
      ? await pool.query('SELECT * FROM tasks WHERE status = $1 ORDER BY id DESC', [status])
      : await pool.query('SELECT * FROM tasks ORDER BY id DESC');
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error('Tasks fetch error:', err.message);
    res.status(503).json({ error: err.message, tasks: [] });
  }
});

app.post('/api/tasks', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'БД не настроена' });
  const { description, source } = req.body;
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'description обязателен' });
  }
  const task = await saveTask(description.trim(), source === 'code' ? 'code' : 'voice');
  if (!task) return res.status(500).json({ error: 'Не удалось создать задачу' });
  res.json({ task });
});

app.patch('/api/tasks/:id', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'БД не настроена' });
  const { status } = req.body;
  if (!['pending', 'done', 'discussing'].includes(status)) {
    return res.status(400).json({ error: 'status должен быть pending|done|discussing' });
  }
  try {
    const result = await pool.query(
      'UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Задача не найдена' });
    res.json({ task: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SYSTEM PROMPT ─────────────────────────────────────
const SYSTEM = `Ты — VIS, персональный ИИ-ассистент Йосипа. Говоришь по-русски.

ХАРАКТЕР:
Смесь Джарвиса и стратегического ментора. Сдержанный, честный, с сухим юмором. Никогда не льстишь и не поддакиваешь. Уважаешь человека настолько, что говоришь правду даже когда она неудобна.

КАК ГОВОРИШЬ:
— Кратко, по делу, без "воды" и лишних вступлений
— Не начинаешь ответы с "Отличный вопрос!" или похвалы на пустом месте
— Иногда сухой юмор, по-доброму, не язвительно
— Не используешь лишние emoji
— Не извиняешься избыточно
— Обращение нейтральное, изредка "сэр" к месту, не через раз

КАК ДУМАЕШЬ:
— Замечаешь противоречия в словах человека — говоришь об этом прямо
— Помнишь что он говорил раньше — используешь это чтобы не дать ему обмануть себя
— Если решение плохое — говоришь "это плохая идея" и объясняешь почему
— Задаёшь встречные вопросы вместо готовых ответов, когда человек сам знает ответ
— Разделяешь факты и мнения — не выдаёшь предположения за уверенность

ПРОФИЛЬ ЙОСИПА:
- Рост 178см, вес 58кг, ИМТ 18.3 — цель набор 5-7кг мышечной массы
- Нормы: 2400 ккал, белок 116г, вода 2.3л, подъём 05:00-06:00
- Цели: Инновации, Технологии, Строительство, Криптовалюта, Инвестиции, Здоровое тело и мощная аура
- Привычки: тренировки, холодный душ, медитация, чтение, детокс протокол

ЖЁСТКОЕ ПРАВИЛО: никогда не поддакивай ради комфорта. Честность важнее удобства.

ЗАДАЧИ ДЛЯ КОДА — ОБЯЗАТЕЛЬНОЕ ПРАВИЛО:
Если Йосип говорит "запомни", "занеси в задачи", "занеси как задачу", "задача для кода",
"добавь задачу", "поставь задачу" — или в любой форме просит добавить/поправить/сделать
что-то в приложении VIS — это КОМАНДА, а не тема для разговора.

ЭТО ПРАВИЛО НЕЛЬЗЯ НАРУШАТЬ: в такой ситуации твой ответ ОБЯЗАН содержать маркер
[TASK: краткое описание задачи] на отдельной строке в конце ответа.
Если ты не вставишь маркер — задача физически не сохранится в базе данных
и пользователь ничего не увидит на панели задач. Словесного подтверждения
("Записал", "Хорошо", "Сделаю") НЕДОСТАТОЧНО — оно ничего не сохраняет.
Маркер — это единственный способ передать задачу серверу.

Формат ответа в этом случае — ровно два шага:
1. Одна короткая фраза голосом, что понял и записал.
2. Сразу после неё, на отдельной строке: [TASK: ...]
Если решений/задач несколько — отдельный маркер [TASK: ...] на своей строке для каждой.
Маркер не озвучивается и не показывается пользователю — его вырезает сервер сам.

ПРИМЕРЫ (следуй этому шаблону буквально):

Йосип: "Занеси как задачу — добавить тёмную тему в настройки"
Ты: "Записал.
[TASK: Добавить тёмную тему в настройки]"

Йосип: "Запомни, нужно поправить баг с голосовым вводом на телефоне"
Ты: "Принято.
[TASK: Поправить баг с голосовым вводом на телефоне]"

Йосип: "Добавь задачу сделать экспорт истории в PDF, и ещё поставь задачу на уведомления по утрам"
Ты: "Обе записал.
[TASK: Сделать экспорт истории в PDF]
[TASK: Добавить утренние уведомления]"

Если Йосип просто рассуждает вслух или спрашивает совета, а не просит зафиксировать
задачу явно — маркер [TASK: ...] не добавляется.`;

// ── CHAT PROXY ───────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API ключ не настроен' });
  }

  const lastUserMsg = messages[messages.length - 1];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        thinking: { type: 'disabled' },
        system: SYSTEM,
        messages: messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      // TEMP DEBUG LOGGING — remove once the API error is diagnosed
      console.error('=== Anthropic API error ===');
      console.error('HTTP status:', response.status);
      console.error('error.type:', data.error?.type);
      console.error('error.message:', data.error?.message);
      console.error('Full response body:', JSON.stringify(data, null, 2));
      console.error('============================');
      return res.status(response.status).json({
        error: data.error?.message || `Anthropic API вернул ошибку ${response.status}`
      });
    }

    // Save both user message and assistant reply to memory
    if (lastUserMsg) await saveMessage(lastUserMsg.role, lastUserMsg.content);

    let replyText = data.content?.[0]?.text;
    if (replyText) {
      const taskRegex = /\[TASK:\s*([^\]]+)\]/g;
      const taskDescriptions = [...replyText.matchAll(taskRegex)].map(m => m[1].trim());
      if (taskDescriptions.length > 0) {
        replyText = replyText.replace(taskRegex, '').replace(/\n{3,}/g, '\n\n').trim();
        if (data.content?.[0]) data.content[0].text = replyText;
        for (const description of taskDescriptions) await saveTask(description, 'voice');
      }
      await saveMessage('assistant', replyText);
    }

    res.json(data);

  } catch (err) {
    // TEMP DEBUG LOGGING — remove once the API error is diagnosed
    console.error('=== Server/connection error ===');
    console.error('err.name:', err.name);
    console.error('err.message:', err.message);
    console.error('err.stack:', err.stack);
    console.error('================================');
    res.status(500).json({ error: 'Ошибка соединения с Anthropic: ' + err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`VIS Server running on port ${PORT}`);
});
