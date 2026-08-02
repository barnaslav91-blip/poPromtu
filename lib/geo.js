const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Расстояние по прямой между двумя точками, в метрах
function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Округляем расстояние, чтобы по нему нельзя было вычислить точную точку
function formatDistance(meters) {
  if (meters == null) return null;
  if (meters < 300) return 'меньше 300 м';
  if (meters < 1000) return `${Math.round(meters / 100) * 100} м`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1).replace('.', ',')} км`;
  return `${Math.round(meters / 1000)} км`;
}

function isValidCoords(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

module.exports = { distanceMeters, formatDistance, isValidCoords };
