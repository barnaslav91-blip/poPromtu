const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function extractYoutubeId(input) {
  const value = (input || '').trim();
  if (!value) return null;

  if (YOUTUBE_ID_RE.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1);
    return YOUTUBE_ID_RE.test(id) ? id : null;
  }

  if (url.hostname.endsWith('youtube.com')) {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && YOUTUBE_ID_RE.test(id) ? id : null;
    }
    const shortMatch = url.pathname.match(/^\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (shortMatch) return shortMatch[2];
  }

  return null;
}

module.exports = { extractYoutubeId };
