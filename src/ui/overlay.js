'use strict';
const ICONS = {
  shot: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  replay: '<path d="M4 12a8 8 0 108-8H7"/><path d="M10 1L7 4l3 3"/>',
  record: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  saved: '<path d="M5 13l4 4 10-11"/>',
};
const sound = new Audio('alert.mp3');
const card = document.getElementById('card');
const mark = document.getElementById('mark');
window.overlay.onShow(({ title, kind, dir }) => {
  sound.currentTime = 0;
  sound.play().catch(() => {});
  document.documentElement.dir = dir;
  document.getElementById('title').textContent = title;
  mark.className = kind === 'record' ? 'rec' : '';
  mark.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
  card.classList.remove('on');
  void card.offsetWidth;
  card.classList.add('on');
});
