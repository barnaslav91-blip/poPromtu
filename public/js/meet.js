(function () {
  'use strict';

  /* ---------- время в часовом поясе гостя ---------- */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function dayLabel(date) {
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);

    if (diffDays === 0) return 'сегодня';
    if (diffDays === 1) return 'завтра';
    if (diffDays === -1) return 'вчера';
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
  }

  function humanize(date, format) {
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (format === 'short') return `${dayLabel(date)}, ${time}`;

    const minutesAway = Math.round((date.getTime() - Date.now()) / 60000);
    if (minutesAway >= 0 && minutesAway < 60) {
      return minutesAway <= 1 ? 'прямо сейчас' : `через ${minutesAway} мин · ${time}`;
    }
    if (minutesAway < 0 && minutesAway > -120) return `началась в ${time}`;
    return `${dayLabel(date)} в ${time}`;
  }

  document.querySelectorAll('.js-time').forEach(function (el) {
    const iso = el.getAttribute('data-iso');
    if (!iso) return;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return;
    el.textContent = humanize(date, el.getAttribute('data-format'));
  });

  /* ---------- геолокация ---------- */

  function sendLocation(position) {
    return fetch('/ryadom/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      }),
    });
  }

  function geoErrorText(err) {
    if (err && err.code === 1) return 'Доступ к геолокации запрещён — разрешите его в настройках браузера';
    if (err && err.code === 3) return 'Не успели определить место, попробуйте ещё раз';
    return 'Не удалось определить место';
  }

  const askButton = document.getElementById('ask-location');
  const askStatus = document.getElementById('location-status');

  if (askButton) {
    askButton.addEventListener('click', function () {
      if (!navigator.geolocation) {
        askStatus.textContent = 'Браузер не умеет определять местоположение';
        return;
      }
      askButton.disabled = true;
      askStatus.textContent = 'Определяем…';

      navigator.geolocation.getCurrentPosition(
        function (position) {
          sendLocation(position)
            .then(function () {
              window.location.reload();
            })
            .catch(function () {
              askButton.disabled = false;
              askStatus.textContent = 'Сервер не принял координаты, попробуйте ещё раз';
            });
        },
        function (err) {
          askButton.disabled = false;
          askStatus.textContent = geoErrorText(err);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
      );
    });
  }

  /* ---------- форма новой встречи ---------- */

  const form = document.getElementById('new-meet-form');
  if (!form) return;

  const offsetField = document.getElementById('tz_offset');
  const startsAt = document.getElementById('starts_at');
  const latField = document.getElementById('lat');
  const lonField = document.getElementById('lon');
  const geoLabel = document.getElementById('geo-label');
  const geoButton = document.getElementById('use-my-location');

  offsetField.value = String(new Date().getTimezoneOffset());

  function setStartsAt(date) {
    startsAt.value =
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  if (!startsAt.value) {
    const soon = new Date(Date.now() + 60 * 60000);
    soon.setMinutes(Math.ceil(soon.getMinutes() / 15) * 15, 0, 0);
    setStartsAt(soon);
  }

  document.querySelectorAll('.quick-times button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const minutes = btn.getAttribute('data-minutes');
      const tonight = btn.getAttribute('data-tonight');

      if (minutes) {
        setStartsAt(new Date(Date.now() + Number(minutes) * 60000));
      } else if (tonight) {
        const date = new Date();
        date.setHours(Number(tonight), 0, 0, 0);
        if (date.getTime() < Date.now()) date.setDate(date.getDate() + 1);
        setStartsAt(date);
      }
    });
  });

  form.addEventListener('submit', function (event) {
    if (!latField.value || !lonField.value) {
      event.preventDefault();
      geoLabel.textContent = 'Сначала отметьте точку встречи — нажмите «взять точку»';
      geoLabel.classList.remove('ok');
      geoButton.focus();
    }
  });

  geoButton.addEventListener('click', function () {
    if (!navigator.geolocation) {
      geoLabel.textContent = 'Браузер не умеет определять местоположение';
      return;
    }
    geoButton.disabled = true;
    geoLabel.textContent = 'Определяем точку…';
    geoLabel.classList.remove('ok');

    navigator.geolocation.getCurrentPosition(
      function (position) {
        latField.value = position.coords.latitude;
        lonField.value = position.coords.longitude;
        geoLabel.textContent = 'Точка встречи отмечена';
        geoLabel.classList.add('ok');
        geoButton.disabled = false;
        sendLocation(position).catch(function () {});
      },
      function (err) {
        geoButton.disabled = false;
        geoLabel.textContent = geoErrorText(err);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
})();
