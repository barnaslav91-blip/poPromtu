document.addEventListener('click', function (event) {
  const button = event.target.closest('.copy-btn');
  if (!button) return;

  const source = document.getElementById(button.dataset.target);
  if (!source) return;

  const text = source.textContent;
  const done = () => {
    const original = button.dataset.original || button.textContent;
    button.dataset.original = original;
    button.textContent = 'Скопировано ✓';
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done);
    return;
  }

  // Fallback для http и старых мобильных браузеров.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  document.body.removeChild(area);
  done();
});
