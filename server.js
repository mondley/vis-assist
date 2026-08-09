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
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('DB ready — memory enabled');
  } catch (err) {
    console.error('DB init error:', err.message);
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
    res.json({ messages: [] });
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

// ── CHAT PROXY ───────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, system } = req.body;
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: system,
        messages: messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json({
        error: data.error?.message || `Anthropic API вернул ошибку ${response.status}`
      });
    }

    // Save both user message and assistant reply to memory
    if (lastUserMsg) await saveMessage(lastUserMsg.role, lastUserMsg.content);
    const replyText = data.content?.[0]?.text;
    if (replyText) await saveMessage('assistant', replyText);

    res.json(data);

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Ошибка соединения с Anthropic: ' + err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`VIS Server running on port ${PORT}`);
});
