const ACTIVITIES = [
  { id: 'coffee', emoji: '☕️', label: 'Кофе' },
  { id: 'drink', emoji: '🍻', label: 'Выпить' },
  { id: 'food', emoji: '🍽', label: 'Поесть' },
  { id: 'walk', emoji: '🚶', label: 'Прогулка' },
  { id: 'sport', emoji: '🏃', label: 'Спорт / актив' },
  { id: 'talk', emoji: '💬', label: 'Просто поболтать' },
  { id: 'other', emoji: '✨', label: 'Другое' },
];

const BY_ID = new Map(ACTIVITIES.map((a) => [a.id, a]));

function getActivity(id) {
  return BY_ID.get(id) || ACTIVITIES[ACTIVITIES.length - 1];
}

module.exports = { ACTIVITIES, getActivity };
