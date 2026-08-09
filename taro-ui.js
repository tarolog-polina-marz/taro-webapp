/**
 * taro-ui — компонентная библиотека ТАРО Mini App.
 *
 * Принципы (масштабирование):
 * - Только дефолтные стили Telegram: все цвета из CSS-переменных
 *   --tg-theme-*, шрифты системные. Никакой кастомной эстетики —
 *   приложение визуально не отличается от нативного TG.
 * - Чистые функции component(props) -> html string. Без фреймворка:
 *   сегодня vanilla, завтра переносится в React/Vue 1:1.
 * - Никаких inline-цветов в экранах — только токены здесь.
 */
const TaroUI = (() => {
  // ── Design tokens (все из темы Telegram, с фолбэками) ──
  const css = (name, fallback) =>
    `var(--tg-theme-${name}, ${fallback})`;

  const tokens = {
    bg: css('bg-color', '#ffffff'),
    secondaryBg: css('secondary-bg-color', '#f1f1f1'),
    text: css('text-color', '#000000'),
    hint: css('hint-color', '#8e8e93'),
    link: css('link-color', '#2481cc'),
    button: css('button-color', '#2481cc'),
    buttonText: css('button-text-color', '#ffffff'),
    sectionBg: css('section-bg-color', '#ffffff'),
    sectionHeader: css('section-header-text-color', '#8e8e93'),
    sectionSeparator: css('section-separator-color', '#e5e5ea'),
    subtitle: css('subtitle-text-color', '#8e8e93'),
    accent: css('accent-text-color', '#2481cc'),
    destructive: css('destructive-text-color', '#ff3b30'),
  };

  // ── Escape ──
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Атомы ──

  /** Заголовок секции в стиле TG Settings. */
  const sectionHeader = (text) =>
    `<div class="tui-section-header">${esc(text)}</div>`;

  /** Группа-секция (как блоки в настройках TG). */
  const section = (inner, { header = '', footer = '' } = {}) => `
    <div class="tui-section-wrap">
      ${header ? sectionHeader(header) : ''}
      <div class="tui-section">${inner}</div>
      ${footer ? `<div class="tui-section-footer">${esc(footer)}</div>` : ''}
    </div>`;

  /** Строка секции: label слева, value справа, стрелка опционально. */
  const row = (label, value = '', { arrow = false, onClick = '', danger = false } = {}) => `
    <div class="tui-row ${onClick ? 'tui-row-clickable' : ''}" ${onClick ? `onclick="${onClick}"` : ''}>
      <div class="tui-row-label ${danger ? 'tui-danger' : ''}">${esc(label)}</div>
      <div class="tui-row-value">${esc(value)}${arrow ? '<span class="tui-arrow">›</span>' : ''}</div>
    </div>`;

  /** Кнопка. variant: primary | secondary | text | destructive. */
  const button = (text, { variant = 'primary', onClick = '', disabled = false, full = true } = {}) => `
    <button class="tui-btn tui-btn-${variant} ${full ? 'tui-btn-full' : ''}"
      ${onClick ? `onclick="${onClick}"` : ''} ${disabled ? 'disabled' : ''}>
      ${esc(text)}
    </button>`;

  /** Текст-подсказка. */
  const hint = (text, { align = 'center' } = {}) =>
    `<div class="tui-hint" style="text-align:${align}">${esc(text)}</div>`;

  /** Бейдж/чип. */
  const badge = (text, { active = false } = {}) =>
    `<span class="tui-badge ${active ? 'tui-badge-active' : ''}">${esc(text)}</span>`;

  /** Спиннер. */
  const spinner = () => `<div class="tui-spinner"><div></div></div>`;

  /** Пустое состояние. */
  const empty = (title, subtitle = '') => `
    <div class="tui-empty">
      <div class="tui-empty-title">${esc(title)}</div>
      ${subtitle ? `<div class="tui-empty-sub">${esc(subtitle)}</div>` : ''}
    </div>`;

  /** Карточка (контейнер с паддингом на фоне секции). */
  const card = (inner, { onClick = '' } = {}) => `
    <div class="tui-card ${onClick ? 'tui-row-clickable' : ''}" ${onClick ? `onclick="${onClick}"` : ''}>${inner}</div>`;

  /** Большая карта таро (визуальный центр экрана карты дня). */
  const tarotCard = ({ name, reversed = false, sphere = '' }) => `
    <div class="tui-tarot ${reversed ? 'tui-tarot-reversed' : ''}">
      <div class="tui-tarot-inner">
        <div class="tui-tarot-star">✦</div>
        <div class="tui-tarot-name">${esc(name)}</div>
        ${reversed ? '<div class="tui-tarot-pos">перевёрнутая</div>' : ''}
        ${sphere ? `<div class="tui-tarot-sphere">${esc(sphere)}</div>` : ''}
      </div>
    </div>`;

  /** Радио-опция (для select-вопросов и сфер). */
  const option = (label, { value = '', selected = false, onClick = '' } = {}) => `
    <div class="tui-option ${selected ? 'tui-option-selected' : ''}"
      ${onClick ? `onclick="${onClick}"` : ''} data-value="${esc(value)}">
      <span>${esc(label)}</span>
      <span class="tui-check">${selected ? '✓' : ''}</span>
    </div>`;

  /** Поле ввода. type: text | date | textarea. */
  const input = ({ id = '', type = 'text', placeholder = '', value = '' } = {}) => {
    if (type === 'textarea') {
      return `<textarea class="tui-input" id="${esc(id)}" rows="3"
        placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
    }
    return `<input class="tui-input" id="${esc(id)}" type="${esc(type)}"
      placeholder="${esc(placeholder)}" value="${esc(value)}">`;
  };

  /** Тост (уведомление сверху). */
  const toast = (text, { kind = 'info' } = {}) => {
    const el = document.createElement('div');
    el.className = `tui-toast tui-toast-${kind}`;
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('tui-toast-show'));
    setTimeout(() => {
      el.classList.remove('tui-toast-show');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  };

  /** Модалка подтверждения. */
  const confirm = (title, text, onOk) => {
    if (window.Telegram?.WebApp?.popup) {
      window.Telegram.WebApp.popup({
        title, message: text,
        buttons: [{ id: 'ok', type: 'default', text: 'Да' }, { type: 'cancel' }],
      }, (id) => { if (id === 'ok') onOk(); });
      return;
    }
    if (window.confirm(`${title}\n${text}`)) onOk();
  };

  /** Хедер экрана с кнопкой назад. */
  const screenHeader = (title, { back = false } = {}) => `
    <div class="tui-header">
      ${back ? '<div class="tui-header-back" onclick="App.back()">‹</div>' : '<div></div>'}
      <div class="tui-header-title">${esc(title)}</div>
      <div class="tui-header-spacer"></div>
    </div>`;

  /** Таб-бар снизу (дефолтный TG-стиль). */
  const tabBar = (items, active) => `
    <div class="tui-tabbar">
      ${items.map((it) => `
        <div class="tui-tab ${active === it.id ? 'tui-tab-active' : ''}" onclick="App.go('${it.id}')">
          <div class="tui-tab-icon">${it.icon}</div>
          <div class="tui-tab-label">${esc(it.label)}</div>
        </div>`).join('')}
    </div>`;

  return {
    tokens, esc,
    sectionHeader, section, row, button, hint, badge,
    spinner, empty, card, tarotCard, option, input,
    toast, confirm, screenHeader, tabBar,
  };
})();
