const path = require('path');
const PDFDocument = require('pdfkit');

const { LEAD_STATUSES } = require('./promo');

const FONTS = path.join(__dirname, '..', 'assets', 'fonts');
const REGULAR = path.join(FONTS, 'DejaVuSans.ttf');
const BOLD = path.join(FONTS, 'DejaVuSans-Bold.ttf');

const INK = '#1b1b1d';
const MUTED = '#6a6f68';
const RULE = '#c8cec4';
const HEAD_BG = '#e8ede4';

// Ширины подобраны под A4 landscape за вычетом полей: сумма = 762.
const COLUMNS = [
  { key: 'num', title: '№', width: 24, align: 'right' },
  { key: 'created', title: 'Дата и время', width: 90 },
  { key: 'phone', title: 'Телефон', width: 84 },
  { key: 'name', title: 'Имя', width: 78 },
  { key: 'message', title: 'Сообщение', width: 156 },
  { key: 'group', title: 'Источник', width: 120 },
  { key: 'status', title: 'Статус', width: 90 },
  { key: 'reason', title: 'Отметка', width: 70 },
  { key: 'price', title: 'Сумма', width: 50, align: 'right' },
];

const MARGIN = 40;
const ROW_PADDING = 4;
const FONT_SIZE = 8;
const LINE_GAP = 1.5;

function statusLabel(lead) {
  const base = LEAD_STATUSES[lead.effective] || lead.effective;
  if (lead.effective === 'accepted' && lead.auto) return `${base} (п. 4.6)`;
  return base;
}

function noteLabel(lead) {
  const notes = [];
  if (lead.reject_reason) notes.push(lead.reject_reason);
  if (lead.is_duplicate) notes.push('дубль');
  return notes.join('; ');
}

/** Компактная дата: в узкой колонке «20.08.2026, 17:16:51» переносится на две строки. */
function shortDateTime(value) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function rowFor(lead, index) {
  const accepted = lead.effective === 'accepted';

  return {
    num: String(index + 1),
    created: shortDateTime(lead.created_at),
    phone: lead.phone || '',
    name: lead.name || '',
    message: lead.message || '',
    group: lead.group_name || '—',
    status: statusLabel(lead),
    reason: noteLabel(lead),
    price: accepted ? Number(lead.price).toFixed(2) : '—',
  };
}

/** Высота строки — по самой длинной ячейке, чтобы текст не наезжал. */
function rowHeight(doc, row) {
  let max = 0;
  COLUMNS.forEach((col) => {
    const height = doc.heightOfString(row[col.key] || '', {
      width: col.width - ROW_PADDING * 2,
      lineGap: LINE_GAP,
    });
    if (height > max) max = height;
  });
  return max + ROW_PADDING * 2;
}

function drawTableHeader(doc, x, y) {
  const height = 20;
  doc.rect(x, y, COLUMNS.reduce((sum, c) => sum + c.width, 0), height).fill(HEAD_BG);
  doc.font('bold').fontSize(FONT_SIZE).fillColor(INK);

  let cursor = x;
  COLUMNS.forEach((col) => {
    doc.text(col.title, cursor + ROW_PADDING, y + 6, {
      width: col.width - ROW_PADDING * 2,
      align: col.align || 'left',
      lineBreak: false,
    });
    cursor += col.width;
  });

  return y + height;
}

function drawRow(doc, row, x, y, height) {
  doc.font('regular').fontSize(FONT_SIZE).fillColor(INK);

  let cursor = x;
  COLUMNS.forEach((col) => {
    doc.text(row[col.key] || '', cursor + ROW_PADDING, y + ROW_PADDING, {
      width: col.width - ROW_PADDING * 2,
      align: col.align || 'left',
      lineGap: LINE_GAP,
    });
    cursor += col.width;
  });

  doc
    .moveTo(x, y + height)
    .lineTo(x + COLUMNS.reduce((sum, c) => sum + c.width, 0), y + height)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
}

function drawIntro(doc, { client, period, summary, moneyLabel, generatedAt }) {
  doc.font('bold').fontSize(15).fillColor(INK).text('Реестр заявок', MARGIN, MARGIN);

  doc.font('regular').fontSize(9).fillColor(MUTED);
  doc.text(`${client.name} · период: ${period} · сформирован ${generatedAt}`, MARGIN, MARGIN + 22);

  const parts = [
    `всего: ${summary.total}`,
    `принято: ${summary.accepted}`,
    `отклонено: ${summary.rejected}`,
    `ожидают: ${summary.pending}`,
    `дублей: ${summary.duplicates}`,
    `к оплате: ${summary.amount.toFixed(2)} ${moneyLabel}`,
  ];

  doc.font('bold').fontSize(9).fillColor(INK);
  doc.text(parts.join('   ·   '), MARGIN, MARGIN + 38);

  return MARGIN + 58;
}

/** Реестр заявок за период: A4 альбомный, шапка таблицы повторяется на каждой странице. */
function buildLeadsPdf({ client, leads, period, moneyLabel, summary }) {
  return new Promise((resolve, reject) => {
    // bufferPages нужен, чтобы в конце вернуться и проставить «стр. N из M».
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      bufferPages: true,
    });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('regular', REGULAR);
    doc.registerFont('bold', BOLD);
    doc.info.Title = `Реестр заявок — ${client.name} — ${period}`;

    const generatedAt = new Date().toLocaleString('ru-RU');
    const bottom = doc.page.height - MARGIN - 16;

    let y = drawIntro(doc, { client, period, summary, moneyLabel, generatedAt });
    y = drawTableHeader(doc, MARGIN, y);

    if (!leads.length) {
      doc
        .font('regular')
        .fontSize(9)
        .fillColor(MUTED)
        .text('За этот период заявок не было.', MARGIN, y + 10);
    }

    leads.forEach((lead, index) => {
      const row = rowFor(lead, index);
      const height = rowHeight(doc, row);

      if (y + height > bottom) {
        doc.addPage();
        y = drawTableHeader(doc, MARGIN, MARGIN);
      }

      drawRow(doc, row, MARGIN, y, height);
      y += height;
    });

    // Нумерация страниц проставляется в конце: до этого их количество неизвестно.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      // Футер печатается ниже нижнего поля; без обнуления margin pdfkit
      // считает это переполнением и добавляет пустую страницу на каждую сноску.
      doc.page.margins.bottom = 0;
      doc
        .font('regular')
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `${client.name} · ${period}`,
          MARGIN,
          doc.page.height - MARGIN + 2,
          { width: 300, lineBreak: false }
        )
        .text(
          `Стр. ${i - range.start + 1} из ${range.count}`,
          doc.page.width - MARGIN - 120,
          doc.page.height - MARGIN + 2,
          { width: 120, align: 'right', lineBreak: false }
        );
    }

    doc.end();
  });
}

module.exports = { buildLeadsPdf };
