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

// Язык объявления. Задаётся у группы и у каждого блока текста, чтобы
// в одном объявлении не смешались русский заголовок и румынский текст.
const LANGS = {
  ru: 'Русский',
  ro: 'Română',
};

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

// Срок на возражение из п. 4.2 договора: после него заявка считается принятой.
const DISPUTE_HOURS = 48;

// Причины отклонения из п. 4.4 договора — список закрытый, клиент выбирает из него.
const REJECT_REASONS = [
  'Телефон недоступен после 3 попыток',
  'Человек отрицает факт обращения',
  'Не наша услуга',
  'Меньше минимального объёма заказа',
  'Вне зоны работы',
  'Дубль',
  'Ложная или тестовая заявка',
];

function placeholderValues(client, extra) {
  // В румынском объявлении город и услуга берутся из румынских полей,
  // а если они пустые — из основных.
  const ro = extra && extra.lang === 'ro';

  return {
    city: (ro && client.city_ro) || client.city || '',
    service: (ro && client.service_ro) || client.service || '',
    name: (ro && client.name_ro) || client.name || '',
    price: (ro && client.price_from_ro) || client.price_from || '',
    phone: client.phone || '',
    // Ссылка своя у каждой группы, поэтому приходит извне, а не из клиента.
    link: (extra && extra.link) || '',
  };
}

/** Название, город, услуга и цена на нужном языке — для лендинга. */
function localized(client, lang) {
  return placeholderValues(client, { lang });
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

/** Все сочетания заголовок × текст × призыв в пределах одного языка. */
function buildCombos(templates, lang) {
  const byKind = { headline: [], body: [], cta: [] };
  templates.forEach((t) => {
    if (!t.active || !byKind[t.kind]) return;
    if (lang && (t.lang || 'ru') !== lang) return;
    byKind[t.kind].push(t);
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

/** Румынский набор. Не перевод построчно, а тот же смысл живым языком. */
function seedTemplatesRo(service) {
  const what = service || 'serviciu';
  return [
    { kind: 'headline', text: `${what} — {{city}} și împrejurimi` },
    { kind: 'headline', text: 'Aveți nevoie de cosit? Mă ocup săptămâna aceasta' },
    { kind: 'headline', text: '{{city}}: mă deplasez chiar în ziua solicitării' },
    {
      kind: 'body',
      text:
        'Lucrez atent și fără bătăi de cap. Utilajul, combustibilul și firul sunt ale mele — fără costuri suplimentare.\n' +
        'Preț: {{price}}. Suma exactă o spun imediat după fotografii — trimiteți-le pe mesagerie.',
    },
    {
      kind: 'body',
      text:
        'Mă ocup și de terenurile dificile, de care alții refuză.\n' +
        'Întâi văd fotografiile și spun prețul exact, apoi stabilim ziua. Fără surprize la final.\n' +
        'Orientativ: {{price}}.',
    },
    {
      kind: 'body',
      text:
        'Lucrez singur, fără subcontractanți, așa că răspund personal de calitate.\n' +
        'Pot veni în aceeași zi sau a doua zi. Prețul — {{price}}, în funcție de volum.',
    },
    {
      kind: 'cta',
      text: 'Sunați sau scrieți: {{phone}} (apel, Viber, WhatsApp)\nCerere online: {{link}}',
    },
    {
      kind: 'cta',
      text:
        'Trimiteți fotografii pe Viber sau WhatsApp la {{phone}} — vă spun prețul imediat.\n' +
        'Sau lăsați numărul aici și vă sun eu: {{link}}',
    },
    { kind: 'cta', text: 'Mai am zile libere săptămâna aceasta. {{phone}} — {{name}}\n{{link}}' },
  ];
}

/** Шаблоны-примеры: показывают формат и сразу дают рабочее объявление. */
function seedTemplates(service, lang) {
  if (lang === 'ro') return seedTemplatesRo(service);

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
  LANGS,
  REJECT_REASONS,
  DISPUTE_HOURS,
  render,
  localized,
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
