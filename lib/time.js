// На сервере не знаем часовой пояс гостя, поэтому отдаём ISO-строку,
// а красиво форматирует её клиентский скрипт. Текст ниже — запасной вариант.
function isoString(value) {
  return new Date(value).toISOString();
}

function fallbackWhen(value) {
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
  return `${formatted} UTC`;
}

module.exports = { isoString, fallbackWhen };
