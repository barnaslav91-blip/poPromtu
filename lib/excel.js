const ExcelJS = require('exceljs');

const { LEAD_STATUSES, NETWORKS, LANGS } = require('./promo');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDE4' } };
const BORDER = { style: 'thin', color: { argb: 'FFBFC6BA' } };

const COLUMNS = [
  { header: '№', key: 'num', width: 5 },
  { header: 'Дата и время', key: 'created', width: 18 },
  { header: 'Телефон', key: 'phone', width: 16 },
  { header: 'Имя', key: 'name', width: 18 },
  { header: 'Сообщение', key: 'message', width: 40 },
  { header: 'Группа-источник', key: 'group', width: 26 },
  { header: 'Площадка', key: 'network', width: 15 },
  { header: 'Язык', key: 'lang', width: 10 },
  { header: 'Канал', key: 'source', width: 12 },
  { header: 'Статус', key: 'status', width: 14 },
  { header: 'Принята по сроку', key: 'auto', width: 17 },
  { header: 'Причина отказа', key: 'reason', width: 30 },
  { header: 'Дубль', key: 'duplicate', width: 9 },
  { header: 'Сумма', key: 'price', width: 12 },
];

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 22;
  row.eachCell((cell) => {
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  });
}

/**
 * Книга с заявками за период: лист с данными и лист со сводкой.
 * Телефон пишется текстом — иначе Excel съедает ведущий ноль в 069...
 */
async function buildLeadsWorkbook({ client, leads, period, moneyLabel }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'poPromtu Промо';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Заявки', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = COLUMNS;

  leads.forEach((lead, index) => {
    const accepted = lead.effective === 'accepted';
    const row = sheet.addRow({
      num: index + 1,
      created: new Date(lead.created_at),
      phone: lead.phone,
      name: lead.name,
      message: lead.message,
      group: lead.group_name || '',
      network: NETWORKS[lead.network] || lead.network || '',
      lang: LANGS[lead.lang] || '',
      source: lead.source,
      status: LEAD_STATUSES[lead.effective] || lead.effective,
      auto: lead.auto ? 'да' : '',
      reason: lead.reject_reason,
      duplicate: lead.is_duplicate ? 'да' : '',
      price: accepted ? Number(lead.price) : null,
    });

    row.getCell('created').numFmt = 'dd.mm.yyyy hh:mm';
    // Текстовый формат, чтобы 069112233 не превратилось в 69112233.
    row.getCell('phone').numFmt = '@';
    row.getCell('phone').alignment = { horizontal: 'left' };
    row.getCell('price').numFmt = '#,##0.00';
    row.getCell('message').alignment = { wrapText: true, vertical: 'top' };
  });

  styleHeader(sheet);

  if (leads.length) {
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  }

  buildSummarySheet(workbook, { client, leads, period, moneyLabel });

  return workbook.xlsx.writeBuffer();
}

function buildSummarySheet(workbook, { client, leads, period, moneyLabel }) {
  const sheet = workbook.addWorksheet('Сводка');
  sheet.columns = [
    { key: 'label', width: 44 },
    { key: 'value', width: 18 },
    { key: 'extra', width: 14 },
  ];

  const accepted = leads.filter((l) => l.effective === 'accepted');
  const amount = accepted.reduce((sum, l) => sum + Number(l.price), 0);

  const add = (label, value, bold) => {
    const row = sheet.addRow({ label, value });
    if (bold) row.font = { bold: true };
    return row;
  };

  add('Клиент', client.name, true);
  add('Период', period);
  add('Валюта', moneyLabel);
  sheet.addRow({});

  add('Всего заявок', leads.length, true);
  add('Принято', accepted.length);
  add('— в том числе по истечении срока возражения', leads.filter((l) => l.auto).length);
  add('Отклонено', leads.filter((l) => l.effective === 'rejected').length);
  add('Ожидают решения', leads.filter((l) => l.effective === 'new').length);
  add('Дублей (не тарифицируются)', leads.filter((l) => l.is_duplicate).length);

  const totalRow = add('К оплате', amount, true);
  totalRow.getCell('value').numFmt = '#,##0.00';

  sheet.addRow({});
  const head = sheet.addRow({ label: 'Источник', value: 'Всего', extra: 'Принято' });
  head.font = { bold: true };
  head.fill = HEADER_FILL;

  const bySource = new Map();
  leads.forEach((lead) => {
    const key = lead.group_name || 'Без источника';
    const stat = bySource.get(key) || { total: 0, accepted: 0 };
    stat.total += 1;
    if (lead.effective === 'accepted') stat.accepted += 1;
    bySource.set(key, stat);
  });

  [...bySource.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([name, stat]) => {
      sheet.addRow({ label: name, value: stat.total, extra: stat.accepted });
    });
}

/**
 * Имя файла для Content-Disposition. Кириллица допустима только в filename*
 * по RFC 5987, поэтому отдаём оба варианта: осмысленную латиницу для старых
 * браузеров и полное имя для всех остальных.
 */
function contentDisposition(filename, asciiFallback) {
  const ascii = (asciiFallback || 'export.xlsx').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

module.exports = { buildLeadsWorkbook, contentDisposition };
