const NETWORKS = {
  facebook: 'Facebook',
  ok: 'Одноклассники',
  telegram: 'Telegram',
  viber: 'Viber',
  other: 'Другое',
};

const TEMPLATE_KINDS = {
  headline: 'Заголовок',
  body: 'Основной текст',
  cta: 'Призыв к действию',
};

const LEAD_STATUSES = {
  new: 'Новая',
  accepted: 'Принята',
  rejected: 'Отклонена',
};

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

// Срок на возражение из п. 4.2 договора: после него заявка считается принятой.
const DISPUTE_HOURS = 48;

// Причины отклонения из п. 4.4 договора — список закрытый, клиент выбирает из него.
const REJECT_REASONS = [
  'Телефон недоступен после 3 попыток',
  'Человек отрицает факт обращения',
  'Не наша услуга',
  'Вне зоны работы',
  'Дубль',
  'Ложная или тестовая заявка',
];

function placeholderValues(client, extra) {
  return {
    city: client.city || '',
    phone: client.phone || '',
    service: client.service || '',
    name: client.name || '',
    price: client.price_from || '',
    // Ссылка своя у каждой группы, поэтому приходит извне, а не из клиента.
    link: (extra && extra.link) || '',
  };
}

/**
 * Подставляет {{city}}, {{phone}} и т.п. Неизвестные плейсхолдеры оставляет
 * как есть, чтобы опечатка в шаблоне была заметна, а не молча съедалась.
 */
function render(text, client, extra) {
  const values = placeholderValues(client, extra);
  return (text || '').replace(PLACEHOLDER_RE, (match, key) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

/** Ссылка на лендинг конкретной группы — источник, по которому считаются заявки. */
function groupLink(baseUrl, client, groupId) {
  return `${baseUrl}/l/${client.token}/${groupId}`;
}

function hasLinkPlaceholder(text) {
  return /\{\{\s*link\s*\}\}/i.test(text || '');
}

/** Молчание дольше срока возражения = принятие. Это п. 4.6 договора. */
function isAutoAccepted(lead) {
  if (lead.status !== 'new') return false;
  const hours = (Date.now() - new Date(lead.created_at).getTime()) / 3600000;
  return hours >= DISPUTE_HOURS;
}

/** Статус для расчётов: с учётом автоприёмки по истечении срока. */
function effectiveStatus(lead) {
  return isAutoAccepted(lead) ? 'accepted' : lead.status;
}

/** Все сочетания заголовок × текст × призыв. */
function buildCombos(templates) {
  const byKind = { headline: [], body: [], cta: [] };
  templates.forEach((t) => {
    if (t.active && byKind[t.kind]) byKind[t.kind].push(t);
  });

  // Без заголовка или тела объявление не собрать, призыв необязателен.
  if (!byKind.headline.length || !byKind.body.length) return [];
  const ctas = byKind.cta.length ? byKind.cta : [null];

  const combos = [];
  byKind.headline.forEach((headline) => {
    byKind.body.forEach((body) => {
      ctas.forEach((cta) => {
        combos.push({
          key: `h${headline.id}-b${body.id}-c${cta ? cta.id : 0}`,
          headline,
          body,
          cta,
        });
      });
    });
  });
  return combos;
}

function composeText(combo, client, extra) {
  const parts = [combo.headline.text, combo.body.text];
  if (combo.cta) parts.push(combo.cta.text);
  return render(parts.join('\n\n').trim(), client, extra);
}

/**
 * Выбирает сочетание, которое дольше всего не публиковалось в этой группе.
 * recentKeys — combo_key прошлых постов группы, от свежих к старым.
 */
function pickCombo(combos, recentKeys) {
  if (!combos.length) return null;

  const freshness = new Map();
  recentKeys.forEach((key, index) => {
    if (!freshness.has(key)) freshness.set(key, index);
  });

  let best = [];
  let bestScore = -1;
  combos.forEach((combo) => {
    const score = freshness.has(combo.key) ? freshness.get(combo.key) : Number.MAX_SAFE_INTEGER;
    if (score > bestScore) {
      bestScore = score;
      best = [combo];
    } else if (score === bestScore) {
      best.push(combo);
    }
  });

  return best[Math.floor(Math.random() * best.length)];
}

/** То же правило ротации, но для картинок. */
function pickImage(images, recentImageIds) {
  const active = images.filter((img) => img.active);
  if (!active.length) return null;

  const freshness = new Map();
  recentImageIds.forEach((id, index) => {
    if (id !== null && !freshness.has(id)) freshness.set(id, index);
  });

  let best = [];
  let bestScore = -1;
  active.forEach((image) => {
    const score = freshness.has(image.id) ? freshness.get(image.id) : Number.MAX_SAFE_INTEGER;
    if (score > bestScore) {
      bestScore = score;
      best = [image];
    } else if (score === bestScore) {
      best.push(image);
    }
  });

  return best[Math.floor(Math.random() * best.length)];
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

/**
 * Ключ для поиска дублей. 069112233 и +37369112233 — один и тот же номер,
 * поэтому сравниваем по последним восьми цифрам (абонентская часть).
 */
function phoneKey(phone) {
  const digits = normalizePhone(phone);
  return digits.length > 8 ? digits.slice(-8) : digits;
}

/** Шаблоны-примеры: показывают формат и сразу дают рабочее объявление. */
function seedTemplates(service) {
  const what = service || 'услуга';
  return [
    { kind: 'headline', text: `${what} — {{city}} и район` },
    { kind: 'headline', text: `Нужен ${what.toLowerCase()}? Возьмусь на этой неделе` },
    { kind: 'headline', text: `{{city}}: ${what.toLowerCase()}, выезд в день обращения` },
    {
      kind: 'body',
      text:
        'Работаю аккуратно и без лишней суеты. Инструмент, расходники и топливо свои — доплат нет.\n' +
        'Цена: {{price}}. Точную сумму назову сразу по фото — пришлите в мессенджер.',
    },
    {
      kind: 'body',
      text:
        'Берусь и за сложные объекты, от которых отказываются другие.\n' +
        'Сначала смотрю фото и называю точную цену, потом договариваемся о дне. Без сюрпризов в конце.\n' +
        'Ориентир по цене: {{price}}.',
    },
    {
      kind: 'body',
      text:
        'Делаю сам, без подрядчиков, поэтому за качество отвечаю лично.\n' +
        'Могу приехать в день обращения или на следующий. Цена — {{price}}, зависит от объёма.',
    },
    // {{link}} есть в каждом призыве: без него заявку не привязать к группе,
    // и статистика «что работает» останется пустой.
    {
      kind: 'cta',
      text: 'Звоните или пишите: {{phone}} (звонок, Viber, WhatsApp)\nЗаявка онлайн: {{link}}',
    },
    {
      kind: 'cta',
      text:
        'Пришлите фото в Viber или WhatsApp на {{phone}} — назову цену сразу.\n' +
        'Или оставьте номер здесь, перезвоню сам: {{link}}',
    },
    { kind: 'cta', text: 'Свободные дни на этой неделе есть. {{phone}} — {{name}}\n{{link}}' },
  ];
}

module.exports = {
  NETWORKS,
  TEMPLATE_KINDS,
  LEAD_STATUSES,
  REJECT_REASONS,
  DISPUTE_HOURS,
  render,
  groupLink,
  hasLinkPlaceholder,
  isAutoAccepted,
  effectiveStatus,
  buildCombos,
  composeText,
  pickCombo,
  pickImage,
  normalizePhone,
  phoneKey,
  seedTemplates,
};
