const API_TIMEOUT_MS = 10000;

// Переопределяется только в тестах; в бою это всегда Bot API Telegram.
const API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isEnabled() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

/**
 * Отправляет сообщение. Никогда не бросает: уведомление не должно ронять
 * приём заявки — заявка важнее уведомления о ней.
 */
async function sendMessage(chatId, html) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, error: 'не настроено' };

  try {
    const response = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      return { ok: false, error: payload.description || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'таймаут' : err.message };
  }
}

function formatLead(client, lead, groupName, cabinetUrl) {
  const lines = [
    `<b>Новая заявка — ${escapeHtml(client.name)}</b>`,
    '',
    `Телефон: <b>${escapeHtml(lead.phone)}</b>`,
  ];

  if (lead.name) lines.push(`Имя: ${escapeHtml(lead.name)}`);
  if (lead.message) lines.push('', escapeHtml(lead.message));

  lines.push('', `Источник: ${escapeHtml(groupName || 'не указан')}`);

  if (lead.is_duplicate) {
    lines.push('⚠️ Дубль по номеру — не тарифицируется');
  }

  if (cabinetUrl) {
    lines.push('', `<a href="${escapeHtml(cabinetUrl)}">Открыть кабинет</a>`);
  }

  return lines.join('\n');
}

/**
 * Уведомляет агентство и самого клиента. Оба адресата необязательны:
 * шлём тем, у кого задан chat_id.
 */
async function notifyLead(client, lead, groupName, cabinetUrl) {
  if (!isEnabled()) return;

  const text = formatLead(client, lead, groupName, cabinetUrl);
  const targets = [process.env.TELEGRAM_ADMIN_CHAT_ID, client.telegram_chat_id].filter(Boolean);

  for (const chatId of new Set(targets)) {
    const result = await sendMessage(chatId, text);
    if (!result.ok) {
      console.error(`Telegram: не доставлено в чат ${chatId} — ${result.error}`);
    }
  }
}

module.exports = { isEnabled, sendMessage, notifyLead, escapeHtml };
