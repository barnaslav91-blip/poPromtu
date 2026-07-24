let player;

function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    videoId: window.POPROMTU_VIDEO_ID,
    playerVars: { enablejsapi: 1 },
  });
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = document.getElementById('capture-timestamp');
  const timestampInput = document.getElementById('timestamp_seconds');
  const timestampDisplay = document.getElementById('timestamp-display');

  if (captureBtn) {
    captureBtn.addEventListener('click', () => {
      if (!player || typeof player.getCurrentTime !== 'function') return;
      const seconds = Math.floor(player.getCurrentTime());
      timestampInput.value = seconds;
      timestampDisplay.textContent = formatTime(seconds);
    });
  }

  document.querySelectorAll('.seek-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!player || typeof player.seekTo !== 'function') return;
      player.seekTo(Number(btn.dataset.seconds), true);
      player.playVideo();
    });
  });
});
