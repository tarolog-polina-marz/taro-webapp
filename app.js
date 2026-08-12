/**
 * ТАРО Mini App v2 — полный пользовательский флоу.
 *
 * Флоу нового пользователя:
 *   бот /start → Mini App → онбординг (имя, дата рождения, сфера —
 *   по одному вопросу) → ритуал карты дня (рубашка → переворот →
 *   трактовка → «совпало?») → история карт.
 *
 * Монетизация: «Вопрос к картам» (ИИ-ответ) — 1/день бесплатно,
 * 3/день в подписке → экран тарифов → оплата Telegram Stars.
 *
 * Экраны: home, onboarding, history, ask, plans, profile, question_form.
 * Тема: «Ночь и золото» (night.css).
 */

// ── Telegram WebApp init ──
const tg = window.Telegram?.WebApp;

const App = (() => {
  const state = {
    screen: 'home',
    history: [],
    profile: null,
    questions: [],
    answers: {},
    card: null,            // карта дня сегодня
    cardHistory: [],       // прошлые карты
    cardHistoryLoaded: false,
    readings: [],          // ответы на вопросы (история из БД)
    readingsLoaded: false,
    testimonials: [],
    spheres: [],
    plans: [],
    shopItems: [],
    shopItemsLoaded: false,
    readingServices: [],
    bookingSlots: [],
    loading: false,
    askLimitHit: false,    // дневной лимит вопросов исчерпан → показываем пейвол
    justDrawn: false,      // карта только что вытянута → играем 3D-переворот
    onboardingStep: 0,
    askSphere: null,       // выбранная сфера для вопроса
    drawing: false,        // анимация вытягивания карты
    histTab: 'all',        // история: 'all' | 'cards' | 'questions'
    resetAtMs: null,       // ближайшая полночь МСК (таймер до сброса), ms epoch
    serverOffsetMs: 0,     // серверное время МСК − локальное
  };

  const root = () => document.getElementById('screen');

  // ── Роутер ──
  function go(screen, { push = true } = {}) {
    if (push && state.screen !== screen) state.history.push(state.screen);
    state.screen = screen;
    render();
    tg?.HapticFeedback?.selectionChanged();
    // Ленивая подгрузка данных экранов
    if (screen === 'history' && !state.cardHistoryLoaded) {
      state.cardHistoryLoaded = true;
      loadHistory().then(() => render());
      // Вопросы подтягиваются отдельно — чтобы лента «Всё» была полной.
      loadReadings().then(() => render());
    }
    if (screen === 'shop' && !state.shopItemsLoaded) {
      loadShopItems().then(() => render());
    }
    if (screen === 'booking' && !state.bookingSlots.length) {
      loadReadingServices();
      loadBookingSlots();
    }
  }

  function back() {
    const prev = state.history.pop();
    if (prev) { state.screen = prev; render(); }
    else go('home', { push: false });
  }

  function render() {
    const el = root();
    if (!el) return;
    const screen = Screens[state.screen] ?? Screens.home;
    el.innerHTML = screen(state);
    tg?.ready();
    // Таймер до сброса: обновляем точечно, без перерисовки экрана
    _startResetTimer();
  }

  function setLoading(v) { state.loading = v; render(); }

  // ── Таймер до сброса карты дня (полночь МСК) ──
  // Сервер отдаёт msk_now + next_reset_utc: не зависим от часов устройства.
  let _timerIv = null;
  function _applyClock(res) {
    if (res && res.msk_now && res.next_reset_utc) {
      const serverNow = new Date(res.msk_now).getTime();
      state.serverOffsetMs = serverNow - Date.now();
      state.resetAtMs = new Date(res.next_reset_utc).getTime();
    }
  }
  function _nowCorrected() { return Date.now() + state.serverOffsetMs; }
  function _startResetTimer() {
    if (_timerIv) return;
    _timerIv = setInterval(() => {
      const el = document.getElementById('reset_timer');
      if (!el) return;
      if (!state.resetAtMs) { el.textContent = ''; return; }
      const diff = state.resetAtMs - _nowCorrected();
      if (diff <= 0) {
        // Сброс прошёл: карта должна обновиться — тихо перезапрашиваем
        el.textContent = '';
        state.resetAtMs = null;
        if (state.screen === 'home') { state.card = null; render(); }
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor(diff % 3600000 / 60000);
      const sec = Math.floor(diff % 60000 / 1000);
      el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }, 1000);
  }

  // ── Данные ──
  // Отклик: максимум параллельности. Критичный путь — только me и анкета
  // (нужна до онбординга); остальное подтягивается фоном и не блокирует
  // первый экран (раньше один медленный ответ «завешивал» весь Mini App).
  async function loadBase() {
    const me = await Api.call('me', {});
    if (me.ok) state.profile = me.profile;

    // Критично: анкета (вопросы онбординга + обязательные ответы).
    const critical = Api.call('questionnaire', {}).then(q => {
      if (q.ok) {
        state.questions = q.questions;
        state.answers = q.answers;
        if (q.profile) state.profile = q.profile;
      }
    });

    // Фоновая подгрузка: не ждём — дорисуются сами.
    const background = Promise.all([
      Api.call('spheres', {}),
      Api.call('plans', {}),
      Api.call('testimonials', {}),
      Api.call('reading_history', { limit: 30 }),
    ]).then(([sp, pl, t, rh]) => {
      if (sp.ok) state.spheres = sp.spheres;
      if (pl.ok) state.plans = pl.plans;
      if (t.ok) state.testimonials = t.testimonials || [];
      // Предзагрузка истории вопросов: видна и в «Истории», и под формой «Спросить».
      if (rh.ok) { state.readings = rh.readings || []; state.readingsLoaded = true; }
      // Данные пришли — точечно обновляем текущий экран.
      if (state.screen === 'plans') go('plans', { push: false });
      else render();
    }).catch(() => { /* фон не роняет приложение */ });

    await critical;
    return background;
  }

  async function loadTodayCard() {
    const res = await Api.call('card_today', { dry_run: true });
    if (res.ok) { state.card = res.card; _applyClock(res); }
  }

  async function loadHistory() {
    const res = await Api.call('card_history', { limit: 30 });
    if (res.ok) state.cardHistory = res.cards || [];
  }

  async function loadReadings() {
    if (state.readingsLoaded) return;
    const res = await Api.call('reading_history', { limit: 30 });
    if (res.ok) { state.readings = res.readings || []; state.readingsLoaded = true; }
  }

  function setHistTab(tab) {
    state.histTab = tab;
    if (tab === 'questions') loadReadings().then(() => render());
    render();
  }

  // ── Онбординг: обязательные вопросы по одному ──
  function mandatoryQuestions() {
    return (state.questions || []).filter(q => q.is_mandatory);
  }

  function startOnboarding() {
    state.onboardingStep = 0;
    go('onboarding', { push: false });
  }

  async function submitAnswer(questionId, value) {
    const res = await Api.call('answer', { question_id: questionId, value });
    if (!res.ok) { TaroUI.toast(res.error || 'Не получилось сохранить', { kind: 'error' }); return; }
    state.answers[questionId] = value;
    tg?.HapticFeedback?.notificationOccurred('success');

    // В онбординге: сразу к следующему обязательному вопросу
    if (state.screen === 'onboarding') {
      const mandatory = mandatoryQuestions();
      const idx = mandatory.findIndex(q => q.id === questionId);
      // обновим профиль (answer синхронизирует имя/сферу на сервере)
      const me = await Api.call('me', {});
      if (me.ok) state.profile = me.profile;
      if (idx >= 0 && idx < mandatory.length - 1) {
        state.onboardingStep = idx + 1;
        render();
        return;
      }
      // обязательные закончились — сразу к карте дня
      TaroUI.toast('Готово! Карты открыты ✨');
      go('home', { push: false });
      return;
    }
    await loadQuestionnaire();
  }

  async function skipQuestion(questionId) {
    const res = await Api.call('skip', { question_id: questionId });
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка'); return; }
    if (state.screen === 'onboarding') {
      // skip допустим только для необязательных — в онбординге их нет,
      // но оставим на будущее
      const mandatory = mandatoryQuestions();
      const idx = mandatory.findIndex(q => q.id === questionId);
      if (idx >= 0 && idx < mandatory.length - 1) { state.onboardingStep = idx + 1; render(); return; }
      go('home', { push: false });
      return;
    }
    await loadQuestionnaire();
  }

  async function loadQuestionnaire() {
    const res = await Api.call('questionnaire', {});
    if (res.ok) {
      state.questions = res.questions;
      state.answers = res.answers;
      if (res.profile) state.profile = res.profile;
    }
    render();
  }

  // ── Карта дня: ритуал ──
  async function drawCard() {
    if (state.drawing) return;
    state.drawing = true;
    render();
    tg?.HapticFeedback?.impactOccurred('medium');
    // минимальная пауза, чтобы ритуал ощущался
    await new Promise(r => setTimeout(r, 900));
    const res = await Api.call('card_today', {});
    state.drawing = false;
    if (!res.ok) {
      TaroUI.toast(res.error || 'Карты не ответили 🙈');
      render();
      return;
    }
    state.card = res.card;
    state.justDrawn = true;
    _applyClock(res);
    tg?.HapticFeedback?.notificationOccurred('success');
    render();
    // анимация переворота после рендера (класс добавляется на след. кадр)
    requestAnimationFrame(() => {
      const el = document.querySelector('.flip-card');
      if (el) el.classList.add('flipped');
    });
    setTimeout(() => { state.justDrawn = false; }, 1400);
  }

  // ── Оценка карты («совпало?») ──
  async function reviewCard(matched, rating) {
    if (!state.card?.id) return;
    const res = await Api.call('day_review', {
      card_of_day_id: state.card.id, matched, rating,
    });
    if (res.ok) {
      state.card.reviewed = true;
      tg?.HapticFeedback?.notificationOccurred('success');
      TaroUI.toast('Спасибо! Это помогает картам говорить точнее ✨');
    } else {
      TaroUI.toast(res.error || 'Не получилось 🙈');
    }
    render();
  }

  // ── Вопрос к картам (ИИ) ──
  function setAskSphere(code) { state.askSphere = code; render(); }

  async function askCard() {
    const input = document.getElementById('ask_input');
    const question = (input?.value || '').trim();
    if (question.length < 3) { TaroUI.toast('Напиши вопрос — хотя бы пару слов 🙂'); return; }
    state.loading = true; render();
    const res = await Api.call('ask_card', {
      question,
      sphere: state.askSphere || state.profile?.priority_sphere || 'love',
    });
    state.loading = false;
    if (!res.ok) {
      if (res.code === 'ask_limit') {
        // Лимит дня исчерпан → превращаем отказ в путь к подписке
        tg?.HapticFeedback?.notificationOccurred('warning');
        state.askLimitHit = true;
        render();
        return;
      }
      TaroUI.toast(res.error || 'Не получилось 🙈', { kind: 'error' });
      render();
      return;
    }
    state.askLimitHit = false;
    state.readings.unshift(res.reading);
    state.readingsLoaded = true;
    tg?.HapticFeedback?.notificationOccurred('success');
    state.askSphere = null;
    render();
  }

  // ── Настройка времени карты дня ──
  async function saveCardTime() {
    const input = document.getElementById('card_time_input');
    const time = (input?.value || '').trim();
    const res = await Api.call('set_card_time', { time });
    if (!res.ok) { TaroUI.toast(res.error || 'Не получилось сохранить', { kind: 'error' }); return; }
    if (state.profile) state.profile.card_delivery_time = res.card_delivery_time;
    tg?.HapticFeedback?.notificationOccurred('success');
    TaroUI.toast(`Карта дня будет приходить в ${res.card_delivery_time} МСК 🌙`);
    render();
  }

  // ── Магазин: загрузка товаров ──
  async function loadShopItems() {
    if (state.shopItemsLoaded) return;
    const res = await Api.call('shop_items', {});
    if (res.ok) { state.shopItems = res.items; state.shopItemsLoaded = true; }
    else render();
  }

  // ── Запись к Полине: услуги + слоты ──
  async function loadReadingServices() {
    const res = await Api.call('reading_services', {});
    if (res.ok) state.readingServices = res.services;
    render();
  }

  async function loadBookingSlots() {
    const res = await Api.call('booking_slots', { service_slug: 'one_question' });
    if (res.ok) state.bookingSlots = res.slots;
    render();
  }

  async function bookSlot(slotId) {
    state.loading = true; render();
    const res = await Api.call('book_slot', { slot_id: slotId });
    state.loading = false;
    if (!res.ok) {
      TaroUI.toast(res.error || 'Не получилось забронировать 🙈', { kind: 'error' });
      render();
      return;
    }
    const b = res.booking;
    tg?.HapticFeedback?.notificationOccurred('success');
    // Переход к оплате через deep link
    if (b.deep_link) {
      if (tg?.openTelegramLink) tg.openTelegramLink(b.deep_link);
      else window.open(b.deep_link, '_blank');
    } else {
      TaroUI.toast(`Запись создана! ${b.service_name} — ${b.stars} ⭐`, { kind: 'success' });
    }
  }

  function openPolina() {
    const url = 'https://t.me/PolinaMarz';
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  }

  // ── Оплата ──
  async function payPlan(planCode) {
    state.loading = true; render();
    const res = await Api.call('start_payment', { plan_code: planCode });
    state.loading = false;
    if (!res.ok) {
      TaroUI.toast(res.error || 'Оплата пока настраивается 🙏', { kind: 'error' });
      render();
      return;
    }
    const link = res.deep_link;
    if (tg?.openTelegramLink) tg.openTelegramLink(link);
    else window.open(link, '_blank');
  }

  async function payShopItem(slug) {
    // Пока оплата через Stars для товаров не реализована — переброс на Полину
    TaroUI.toast('Оплата товаров скоро! А пока — напиши Полине 🙏');
    setTimeout(() => openPolina(), 1200);
  }

  function openChannel() {
    const url = 'https://t.me/tarolog_polina_marz_channel';
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  }

  // ── Инициализация ──
  async function init() {
    tg?.ready();
    tg?.expand();
    if (tg?.setHeaderColor) tg.setHeaderColor('#0d0c14');
    if (tg?.setBackgroundColor) tg.setBackgroundColor('#0d0c14');

    setLoading(true);
    try {
      await loadBase();
      if (state.profile?.mandatory_done) {
        await loadTodayCard();
        setLoading(false);
        go('home', { push: false });
      } else if (state.profile) {
        setLoading(false);
        startOnboarding();
      } else {
        setLoading(false);
        go('home', { push: false }); // покажет ошибку соединения
      }
    } catch (e) {
      setLoading(false);
      render();
    }
  }

  return {
    state, go, back, render, init, setLoading,
    submitAnswer, skipQuestion, drawCard, reviewCard,
    setAskSphere, askCard, payPlan, openChannel,
    startOnboarding, loadQuestionnaire, setHistTab, saveCardTime,
    loadShopItems, loadReadingServices, loadBookingSlots, bookSlot, openPolina,
    payShopItem,
  };
})();

// ── API-клиент ──
const Api = (() => {
  const base = window.TARO_API_BASE ||
    location.href.replace(/\/?$/, '/') + 'api';

  // Действия, которые НЕ безопасно повторять при сбое
  // (могут списать лимит или создать платёж дважды)
  const NO_RETRY = new Set(['ask_card', 'start_payment']);
  const FETCH_TIMEOUT_MS = 30000; // без таймаута fetch висит вечно → «зависание»

  async function call(action, payload = {}, { retries = 1 } = {}) {
    try {
      const initData = tg?.initData || '';
      const headers = { 'Content-Type': 'application/json' };
      if (window.TARO_ANON_KEY) {
        headers['Authorization'] = 'B' + 'earer ' + window.TARO_ANON_KEY;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(base, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action, initData, ...payload }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // Читаем текст ошибки из тела вместо безликого «HTTP 500»
        let msg = `Сбой на сервере. Попробуй ещё раз 🙏`;
        try {
          const j = await res.json();
          if (j && (j.error || j.message)) msg = j.error || j.message;
        } catch (_) { /* тело не json — оставляем общий текст */ }
        // 5xx — временный сбой: один тихий ретрай (кроме небезопасных действий)
        if (res.status >= 500 && retries > 0 && !NO_RETRY.has(action)) {
          await new Promise(r => setTimeout(r, 700));
          return call(action, payload, { retries: retries - 1 });
        }
        return { ok: false, error: msg };
      }
      return await res.json();
    } catch (e) {
      if (retries > 0 && !NO_RETRY.has(action)) {
        await new Promise(r => setTimeout(r, 700));
        return call(action, payload, { retries: retries - 1 });
      }
      return { ok: false, error: 'Нет связи с сервером' };
    }
  }
  return { call };
})();

// ── Экраны ──
const Screens = {

  // ═══ ГЛАВНЫЙ: Карта дня ═══
  home(s) {
    const tabs = TaroUI.tabBar(TABS, 'home');
    if (s.loading) return TaroUI.spinner() + tabs;
    const profile = s.profile;

    if (!profile) {
      return TaroUI.screenHeader('Карта дня') +
        TaroUI.empty('Не получилось подключиться', 'Закрой приложение и открой его из бота ещё раз') + tabs;
    }
    const name = profile.name || 'друг';

    // Ритуал: карта рубашкой вверх
    if (!s.card && !s.drawing) {
      const body = `
        <div class="home-greeting">
          <div class="home-date">${_todayRu()}</div>
          <h1 class="home-title">Привет, ${TaroUI.esc(name)} 🌙</h1>
          <p class="home-sub">Карты уже перемешаны. Одна из них ждёт именно тебя сегодня.</p>
        </div>
        <div class="card-stage">
          <div class="card-back-standalone">
            <div class="card-back-pattern">✦</div>
          </div>
        </div>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow" onclick="App.drawCard()">
          Вытянуть карту дня
        </button>
        <div class="tui-hint reset-hint" style="margin-top:12px">
          Новая карта через <span id="reset_timer" class="reset-timer">…</span>
        </div>`;
      return TaroUI.screenHeader('Карта дня') + body + tabs;
    }

    // Анимация вытягивания
    if (s.drawing) {
      const body = `
        <div class="home-greeting">
          <h1 class="home-title">Карты слушают…</h1>
          <p class="home-sub">Тасуем колоду и вытягиваем твою карту</p>
        </div>
        <div class="card-stage">
          <div class="card-back-standalone shuffling"><div class="card-back-pattern">✦</div></div>
        </div>
        <div class="tui-spinner" style="margin-top:20px"><div></div></div>`;
      return TaroUI.screenHeader('Карта дня') + body + tabs;
    }

    // Карта получена
    const c = s.card;
    const reviewBlock = c.reviewed
      ? `<div class="review-done">Ты уже оценил(а) карту сегодня ✨</div>`
      : `<div class="review-box">
           <div class="review-q">Совпало с твоим днём?</div>
           <div class="review-btns">
             <button class="review-btn yes" onclick="App.reviewCard(true, 5)">Да ✨</button>
             <button class="review-btn no" onclick="App.reviewCard(false, 2)">Не совсем</button>
           </div>
         </div>`;

    // Следующий шаг воронки: карта дня → личный вопрос → подписка
    const nextStep = `<div class="next-step" onclick="App.go('ask')">
      <div class="next-step-icon">✧</div>
      <div class="next-step-text">
        <div class="next-step-title">Хочешь спросить о своём?</div>
        <div class="next-step-sub">Задай картам личный вопрос — ответ придёт про тебя</div>
      </div>
      <div class="next-step-arrow">›</div>
    </div>`;

    // Воронка: личный расклад у Полины
    const polinaStep = `<div class="next-step polina-step" onclick="App.go('booking')">
      <div class="next-step-icon">✦</div>
      <div class="next-step-text">
        <div class="next-step-title">Личный расклад у Полины</div>
        <div class="next-step-sub">Живой разбор твоей ситуации — запись через календарь</div>
      </div>
      <div class="next-step-arrow">›</div>
    </div>`;

    const body = `
      <div class="card-stage">
        <div class="flip-card ${s.justDrawn ? '' : 'flipped'}">
          <div class="flip-inner">
            <div class="flip-back"><div class="card-back-pattern">✦</div></div>
            <div class="flip-front ${c.reversed ? 'card-reversed' : ''}">
              ${TaroUI.tarotCard({ name: c.card_name, reversed: c.reversed, sphere: c.sphere_label, imageUrl: c.image_url })}
            </div>
          </div>
        </div>
      </div>
      <div class="card-meta">
        <span class="meta-chip">${c.reversed ? 'Перевёрнутая' : 'Прямая'}</span>
        ${c.sphere_label ? `<span class="meta-chip">${TaroUI.esc(c.sphere_label)}</span>` : ''}
      </div>
      <div class="interp-section">
        <div class="interp-title">Что говорят карты</div>
        <p class="interp-text">${_paragraphs(c.interpretation || '')}</p>
      </div>
      ${reviewBlock}
      ${nextStep}
      ${polinaStep}
      <div class="tui-hint" style="margin-top:14px">
        Новая карта через <span id="reset_timer" class="reset-timer">…</span> ·
        <span class="linklike" onclick="App.go('history')">История твоих карт ›</span>
      </div>`;
    return TaroUI.screenHeader('Карта дня') + body + tabs;
  },

  // ═══ ОНБОРДИНГ: вопросы по одному ═══
  onboarding(s) {
    if (s.loading) return TaroUI.spinner();
    const mandatory = App.state ? s.questions.filter(q => q.is_mandatory) : [];
    if (!mandatory.length) { App.go('home', { push: false }); return ''; }
    const idx = Math.min(s.onboardingStep, mandatory.length - 1);
    const q = mandatory[idx];
    const isFirst = idx === 0;

    const dots = mandatory.map((_, i) =>
      `<span class="dot ${i < idx ? 'done' : ''} ${i === idx ? 'active' : ''}"></span>`).join('');

    let field;
    if (q.question_type === 'select' && q.options?.length) {
      field = `<div class="wizard-options">` + q.options.map(opt =>
        TaroUI.option(opt.label, {
          value: opt.value,
          selected: s.answers[q.id] === opt.value,
          onClick: `App.submitAnswer('${q.id}', '${TaroUI.esc(opt.value)}')`,
        })).join('') + `</div>`;
    } else if (q.question_type === 'date') {
      field = `<div class="wizard-field">
        ${TaroUI.input({ id: 'q_input', type: 'date', value: s.answers[q.id] || '' })}
        ${TaroUI.button('Дальше', { onClick: `App.submitAnswer('${q.id}', document.getElementById('q_input').value)` })}
      </div>`;
    } else {
      field = `<div class="wizard-field">
        ${TaroUI.input({ id: 'q_input', type: 'text', placeholder: 'Твой ответ…', value: s.answers[q.id] || '' })}
        ${TaroUI.button('Дальше', { onClick: `App.submitAnswer('${q.id}', document.getElementById('q_input').value)` })}
      </div>`;
    }

    return `
      <div class="wizard">
        <div class="wizard-top">
          ${isFirst ? '<div></div>' : '<div class="wizard-back" onclick="App.state.onboardingStep--; App.render()">‹</div>'}
          <div class="wizard-dots">${dots}</div>
          <div></div>
        </div>
        <div class="wizard-icon">✦</div>
        <h2 class="wizard-title">${TaroUI.esc(q.title)}</h2>
        <p class="wizard-desc">${TaroUI.esc(q.description || 'Ответь как чувствуешь — неверных ответов нет.')}</p>
        ${field}
      </div>`;
  },

  // ═══ ИСТОРИЯ: карты дня + вопросы ═══
  history(s) {
    const tabs = TaroUI.tabBar(TABS, 'history');
    if (s.loading) return TaroUI.spinner() + tabs;

    const seg = `
      <div class="seg-row">
        <div class="seg-btn ${s.histTab === 'cards' ? 'seg-active' : ''}" onclick="App.setHistTab('cards')">Карты дня</div>
        <div class="seg-btn ${s.histTab === 'questions' ? 'seg-active' : ''}" onclick="App.setHistTab('questions')">Вопросы</div>
      </div>`;

    if (s.histTab === 'questions') {
      const items = (s.readings || []).map(r => `
        <div class="hist-item" onclick="this.classList.toggle('open')">
          <div class="hist-row">
            <div class="hist-glyph ${r.reversed ? 'card-reversed' : ''}">✧</div>
            <div class="hist-main">
              <div class="hist-name">${TaroUI.esc(r.card_name)}${r.reversed ? ' · перевёрнутая' : ''}</div>
              <div class="hist-date">${_fmtDateTime(r.created_at)}${r.sphere_label ? ' · ' + TaroUI.esc(r.sphere_label) : ''}</div>
              <div class="hist-q">«${TaroUI.esc(r.question)}»</div>
            </div>
            <div class="hist-chevron">›</div>
          </div>
          <div class="hist-detail"><p>${_paragraphs(r.interpretation || 'Ответ недоступен.')}</p></div>
        </div>`).join('');
      return TaroUI.screenHeader('История', { back: false }) + seg +
        (items
          ? `<div class="hist-list">${items}</div>`
          : TaroUI.empty('Вопросов пока нет', 'Задай картам первый вопрос — ответ сохранится здесь')) + tabs;
    }

    const items = (s.cardHistory || []).map(c => {
      const today = c.draw_date === _todayIso();
      return `
        <div class="hist-item" onclick="this.classList.toggle('open')">
          <div class="hist-row">
            <div class="hist-glyph ${c.reversed ? 'card-reversed' : ''}">✦</div>
            <div class="hist-main">
              <div class="hist-name">${TaroUI.esc(c.card_name)}</div>
              <div class="hist-date">${_fmtDate(c.draw_date)}${today ? ' · сегодня' : ''}${c.sphere_label ? ' · ' + TaroUI.esc(c.sphere_label) : ''}</div>
            </div>
            <div class="hist-chevron">›</div>
          </div>
          <div class="hist-detail"><p>${_paragraphs(c.interpretation || 'Трактовка недоступна.')}</p></div>
        </div>`;
    }).join('');

    return TaroUI.screenHeader('История', { back: false }) + seg +
      (items
        ? `<div class="hist-list">${items}</div>`
        : TaroUI.empty('Пока пусто', 'Вытяни первую карту дня — она появится здесь')) + tabs;
  },

  // ═══ ВОПРОС К КАРТАМ (ИИ) ═══
  ask(s) {
    const tabs = TaroUI.tabBar(TABS, 'ask');
    if (s.loading) return TaroUI.spinner() + tabs;

    const chips = (s.spheres || []).map(sp =>
      `<span class="chip ${(s.askSphere || s.profile?.priority_sphere) === sp.code ? 'chip-active' : ''}"
            onclick="App.setAskSphere('${sp.code}')">${TaroUI.esc(sp.label)}</span>`).join('');

    const results = (s.readings || []).map(r => `
      <div class="reading-card">
        <div class="reading-q">«${TaroUI.esc(r.question)}»</div>
        <div class="reading-cardline">
          ${TaroUI.esc(r.card_name)} ${r.reversed ? '· перевёрнутая' : ''}
        </div>
        ${r.image_url ? `<img class="reading-img" src="${TaroUI.esc(r.image_url)}" alt="${TaroUI.esc(r.card_name)}" loading="lazy">` : ''}
        <p class="reading-text">${_paragraphs(r.interpretation || '')}</p>
      </div>`).join('');

    // Счётчик дневных вопросов (виден только после первой загрузки профиля)
    const used = s.profile?.asks_today;
    const quota = s.profile?.asks_quota;
    const usageLine = (used != null && quota)
      ? `<div class="ask-usage">Вопросов сегодня: <b>${used}</b> из <b>${quota}</b>${s.profile?.tier === 'free' ? ' · без лимитов — в подписке' : ''}</div>`
      : '';

    // Пейвол вместо формы, когда лимит дня исчерпан
    const paywall = `
      <div class="paywall">
        <div class="paywall-icon">✦</div>
        <h3 class="paywall-title">Бесплатный вопрос на сегодня использован</h3>
        <p class="paywall-text">Карты уже отвечали тебе сегодня. Завтра после полуночи будет новый бесплатный вопрос — а подписка открывает ${s.profile?.tier === 'free' ? '3 вопроса каждый день' : 'больше вопросов каждый день'} и глубокие трактовки по твоей анкете.</p>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow" onclick="App.go('plans')">Посмотреть подписки ✦</button>
        <div class="tui-hint" style="margin-top:10px">Оплата в Telegram Stars — отменить можно в любой момент</div>
      </div>`;

    const formBlock = s.askLimitHit ? paywall : `
      <div class="ask-field">
        <textarea class="tui-input" id="ask_input" rows="3" maxlength="500"
          placeholder="Например: что мне важно понять в отношениях прямо сейчас?"></textarea>
        <button class="tui-btn tui-btn-primary tui-btn-full" onclick="App.askCard()">Спросить карты ✦</button>
      </div>`;

    const body = `
      <div class="ask-intro">
        <h2 class="ask-title">Спроси у карт</h2>
        <p class="ask-sub">Задай вопрос, который сейчас важен — карты ответят лично для тебя.</p>
        ${usageLine}
      </div>
      <div class="ask-chips">${chips}</div>
      ${formBlock}
      ${results}`;
    return TaroUI.screenHeader('Вопрос к картам') + body + tabs;
  },

  // ═══ ТАРИФЫ + ОТЗЫВЫ ═══
  plans(s) {
    const tabs = TaroUI.tabBar(TABS, 'plans');
    if (s.loading) return TaroUI.spinner() + tabs;

    const currentTier = s.profile?.tier || 'free';
    const FEATURE_TEXT = {
      basic: ['Карта дня каждый день', '1 вопрос к картам в день', 'История карт'],
      standard: ['Всё из Базового', '3 вопроса к картам в день', 'Глубокие трактовки под твою анкету'],
      premium: ['Всё из Стандарта', 'Вопросы без дневного лимита', 'Приоритет в ответах'],
    };

    const monthly = (s.plans || []).filter(p => !p.is_annual && p.price_cents > 0);
    const annual = (s.plans || []).filter(p => p.is_annual);

    const planCard = (p, { highlight = false } = {}) => {
      const price = `$${(p.price_cents / 100).toFixed(0)}`;
      const per = p.period_months === 12 ? ' / год' : ' / мес';
      const active = p.tier === currentTier;
      const feats = (FEATURE_TEXT[p.tier] || []).map(f => `<li>${TaroUI.esc(f)}</li>`).join('');
      return `
        <div class="plan-card ${highlight ? 'plan-featured' : ''}">
          <div class="plan-head">
            <div class="plan-name">${TaroUI.esc(p.title)}</div>
            ${highlight ? '<div class="plan-flag">2 месяца в подарок</div>' : ''}
          </div>
          <div class="plan-price">${price}<span class="plan-per">${per}</span></div>
          <ul class="plan-feats">${feats}</ul>
          ${active
            ? '<div class="plan-active">Твой тариф ✨</div>'
            : `<button class="tui-btn tui-btn-primary tui-btn-full" onclick="App.payPlan('${p.code}')">Оформить за ⭐</button>`}
        </div>`;
    };

    const testimonials = (s.testimonials || []).slice(0, 4).map(t => `
      <div class="tst-card">
        <div class="tst-stars">${'★'.repeat(t.rating || 5)}</div>
        <p class="tst-text">${TaroUI.esc(t.text)}</p>
        <div class="tst-name">${TaroUI.esc(t.is_anonymous ? 'Гость' : (t.name_display || 'Клиент'))}</div>
      </div>`).join('');

    const body = `
      <div class="plans-intro">
        <h2 class="plans-title">Подписка ТАРО</h2>
        <p class="plans-sub">Карты каждый день, ответы на личные вопросы и трактовки под твою ситуацию.</p>
      </div>
      <div class="plan-grid">${monthly.map(p => planCard(p)).join('')}</div>
      ${annual.length ? `<div class="annual-title">Выгодно на год</div>
        <div class="plan-grid">${annual.map(p => planCard(p, { highlight: true })).join('')}</div>` : ''}
      <div class="tui-hint">Оплата — Telegram Stars ⭐. Годовая подписка = 2 месяца в подарок.</div>
      ${testimonials ? `
        <div class="tst-block">
          <div class="tst-title">Что говорят после раскладов</div>
          ${testimonials}
          <div class="tui-hint"><span class="linklike" onclick="App.openChannel()">Больше отзывов — в канале Полины ›</span></div>
        </div>` : `
        <div class="tst-block">
          <div class="tst-title">Отзывы</div>
          <div class="tui-hint"><span class="linklike" onclick="App.openChannel()">Отзывы о раскладах — в канале Полины ›</span></div>
        </div>`}`;
    return TaroUI.screenHeader('Тарифы') + body + tabs;
  },

  // ═══ ПРОФИЛЬ ═══
  profile(s) {
    const tabs = TaroUI.tabBar(TABS, 'profile');
    if (s.loading) return TaroUI.spinner() + tabs;
    const p = s.profile;
    if (!p) return TaroUI.screenHeader('Профиль') +
      TaroUI.empty('Профиль не найден', 'Напиши боту /start') + tabs;

    const tierNames = { free: 'Бесплатный', basic: 'Базовый', standard: 'Стандарт', premium: 'Премиум' };
    const tierLabel = (tierNames[p.tier] || p.tier) + (p.is_annual ? ' · год' : '');

    const rows = [
      TaroUI.row('Имя', p.name || '—', { arrow: true, onClick: `Screens._openQuestion('name')` }),
      TaroUI.row('Дата рождения', p.birth_date ? _fmtDate(p.birth_date) : '—', { arrow: true, onClick: `Screens._openQuestion('birth_date')` }),
      TaroUI.row('Главная сфера', p.main_sphere_label || '—', { arrow: true, onClick: `Screens._openQuestion('priority_sphere')` }),
    ].join('');

    const curTime = p.card_delivery_time || '08:00';
    const timeBlock = `
      <div class="tui-section-wrap">
        <div class="tui-section-header">Карта дня</div>
        <div class="tui-section">
          <div class="tui-row">
            <div class="tui-row-label">Время карты дня (МСК)</div>
          </div>
          <div class="time-picker-row">
            <input class="tui-input time-input" id="card_time_input" type="time" value="${TaroUI.esc(curTime)}">
            <button class="tui-btn tui-btn-primary time-save" onclick="App.saveCardTime()">Сохранить</button>
          </div>
        </div>
        <div class="tui-section-footer">Карты сами будут присылать расклад в выбранное время.</div>
      </div>`;

    const body = `
      <div class="profile-hero">
        <div class="profile-avatar">✦</div>
        <div class="profile-name">${TaroUI.esc(p.name || 'Гость')}</div>
        <div class="profile-tier">${TaroUI.esc(tierLabel)}</div>
        ${p.tier === 'free' ? `<button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.go('plans')">Улучшить подписку</button>` : ''}
      </div>
      ${TaroUI.section(rows, { header: 'Твои данные' })}
      ${timeBlock}
      ${TaroUI.section(
        TaroUI.row('Полная анкета', 'изменить ответы', { arrow: true, onClick: `App.go('questionnaire')` }) +
        TaroUI.row('Канал Полины', 'открыть', { arrow: true, onClick: 'App.openChannel()' }),
        { header: 'Ещё' }
      )}`;
    return TaroUI.screenHeader('Профиль') + body + tabs;
  },

  // ═══ АНКЕТА (список всех вопросов) ═══
  questionnaire(s) {
    const tabs = TaroUI.tabBar(TABS, 'questionnaire');
    if (s.loading) return TaroUI.spinner() + tabs;

    const questions = s.questions || [];
    const answered = questions.filter(q => s.answers[q.id]).length;

    const rows = questions.map((q) => {
      const val = Screens._displayValue(q, s.answers[q.id]);
      const mark = val ? '✓' : (q.is_mandatory ? '•' : '');
      return TaroUI.row(
        `${mark} ${q.title}`,
        val ? (val.length > 24 ? val.slice(0, 24) + '…' : val) : '—',
        { arrow: true, onClick: `Screens._openQuestion('${q.id}')` }
      );
    }).join('');

    return TaroUI.screenHeader('Анкета', { back: true }) +
      TaroUI.section(rows, {
        header: `Ответов: ${answered} из ${questions.length}`,
        footer: 'Обязательные помечены •. Ответы можно менять в любой момент.',
      }) + tabs;
  },

  // ═══ МАГАЗИН ═══
  shop(s) {
    const tabs = TaroUI.tabBar(TABS, 'shop');
    if (s.loading) return TaroUI.spinner() + tabs;

    const items = s.shopItems || [];
    if (!items.length && !s.shopItemsLoaded) {
      return TaroUI.screenHeader('Магазин') + TaroUI.spinner() + tabs;
    }

    // Группируем по типу
    const groups = {
      deck: { label: 'Колоды', items: items.filter(i => i.product_type === 'deck') },
      service: { label: 'Услуги', items: items.filter(i => i.product_type === 'service') },
      goods: { label: 'Товары', items: items.filter(i => i.product_type === 'goods') },
    };

    const typeIcon = { deck: '🃏', service: '✧', goods: '🕯' };
    const typeLabel = { deck: 'Колода', service: 'Услуга', goods: 'Товар' };

    const itemCard = (item) => {
      const price = `$${(item.price_cents / 100).toFixed(0)}`;
      const delivery = item.requires_delivery ? ' · доставка ПВЗ Ozon' : '';
      return `
        <div class="shop-item">
          <div class="shop-item-type">${typeIcon[item.product_type] || '✦'} ${typeLabel[item.product_type] || ''}</div>
          <div class="shop-item-name">${TaroUI.esc(item.name_ru)}</div>
          <div class="shop-item-price">${price}</div>
          <div class="shop-item-desc">${TaroUI.esc(item.description)}</div>
          <button class="tui-btn tui-btn-primary tui-btn-full" onclick="App.payShopItem('${item.slug}')">${price} — купить</button>
          ${delivery ? `<div class="tui-hint">${delivery}</div>` : ''}
        </div>`;
    };

    const polinaCTA = `
      <div class="polina-cta" onclick="App.go('booking')">
        <div class="polina-cta-icon">✧</div>
        <div class="polina-cta-text">
          <div class="polina-cta-title">Личный расклад у Полины</div>
          <div class="polina-cta-sub">Запишись на живой расклад — Полина разберёт твою ситуацию</div>
        </div>
        <div class="polina-cta-arrow">›</div>
      </div>`;

    let body = `
      <div class="shop-intro">
        <h2 class="shop-title">Магазин</h2>
        <p class="shop-sub">Колоды, свечи, услуги — всё для практики таро. Доставка по всему СНГ.</p>
      </div>
      ${polinaCTA}`;

    for (const [type, group] of Object.entries(groups)) {
      if (!group.items.length) continue;
      body += `
        <div class="shop-group">
          <div class="shop-group-title">${group.label}</div>
          ${group.items.map(itemCard).join('')}
        </div>`;
    }

    body += `
      <div class="shop-individual">
        <div class="shop-individual-title">Индивидуальный заказ</div>
        <p class="shop-individual-text">Не нашёл подходящее? Опиши свою ситуацию — Полина решит, сможет ли помочь.</p>
        <button class="tui-btn tui-btn-secondary tui-btn-full" onclick="App.openPolina()">Написать Полине ›</button>
      </div>`;

    return TaroUI.screenHeader('Магазин') + body + tabs;
  },

  // ═══ ЗАПИСЬ К ПОЛИНЕ ═══
  booking(s) {
    if (s.loading) return TaroUI.spinner();

    const slots = s.bookingSlots || [];
    const services = s.readingServices || [];

    // Группируем слоты по дате
    const byDate = {};
    for (const slot of slots) {
      if (!byDate[slot.date]) byDate[slot.date] = [];
      byDate[slot.date].push(slot);
    }

    const dates = Object.keys(byDate).sort();

    const dateCard = (date) => {
      const daySlots = byDate[date];
      const dateLabel = _fmtDateLong(date);
      const timeBtns = daySlots.map(slot => {
        const timeStr = String(slot.time).slice(0, 5);
        const isAnnual = slot.type === 'annual_only';
        return `<button class="slot-btn ${isAnnual ? 'slot-annual' : ''}" onclick="App.bookSlot('${slot.id}')">${timeStr}${isAnnual ? ' ★' : ''}</button>`;
      }).join('');
      return `
        <div class="booking-date">
          <div class="booking-date-label">${dateLabel}</div>
          <div class="slot-row">${timeBtns}</div>
        </div>`;
    };

    const servicesList = services.map(sv => {
      const price = `$${(sv.price_cents / 100).toFixed(0)}`;
      return `<div class="service-row">
        <div class="service-name">${TaroUI.esc(sv.name_ru)}</div>
        <div class="service-meta">${sv.duration_min} мин · ${price}</div>
      </div>`;
    }).join('');

    const body = `
      <div class="booking-intro">
        <h2 class="booking-title">Запись к Полине</h2>
        <p class="booking-sub">Выбери удобное время — расклад делается лично, срок ~3 дня. 100% предоплата через Telegram Stars.</p>
      </div>
      ${servicesList ? `<div class="booking-services">${servicesList}</div>` : ''}
      <div class="booking-slots">
        <div class="booking-slots-title">Свободные слоты</div>
        ${dates.length
          ? dates.map(dateCard).join('')
          : (slots.length === 0
            ? TaroUI.empty('Слоты загружаются…', 'Подожди пару секунд')
            : TaroUI.empty('Все слоты заняты', 'Полина откроет новые скоро — загляни позже'))
        }
      </div>
      <div class="tui-hint" style="margin-top:16px">
        Нужна срочная консультация? <span class="linklike" onclick="App.openPolina()">Напиши Полине напрямую ›</span>
      </div>`;

    return TaroUI.screenHeader('Запись к Полине', { back: true }) + body;
  },

  _displayValue(q, val) {
    if (!val) return '';
    if (q.question_type === 'select' && q.options?.length) {
      const opt = q.options.find(o => o.value === val);
      if (opt) return opt.label;
    }
    return String(val);
  },

  _openQuestion(idOrKey) {
    const q = (App.state.questions || []).find(x => x.id === idOrKey || x.key === idOrKey);
    if (!q) return;
    App.state._editing = q;
    App.go('question_form', { push: true });
  },

  question_form(s) {
    const q = s._editing;
    if (!q) { App.go('profile', { push: false }); return ''; }

    let field;
    if (q.question_type === 'select' && q.options?.length) {
      field = `<div class="wizard-options">` + q.options.map(opt => TaroUI.option(opt.label, {
        value: opt.value,
        selected: s.answers[q.id] === opt.value,
        onClick: `App.submitAnswer('${q.id}', '${TaroUI.esc(opt.value)}')`,
      })).join('') + `</div>`;
    } else if (q.question_type === 'date') {
      field = `<div class="tui-section">${TaroUI.input({ id: 'q_input', type: 'date', value: s.answers[q.id] || '' })}</div>`;
    } else if (q.question_type === 'textarea') {
      field = `<div class="tui-section">${TaroUI.input({ id: 'q_input', type: 'textarea', placeholder: 'Расскажи своими словами…', value: s.answers[q.id] || '' })}</div>`;
    } else {
      field = `<div class="tui-section">${TaroUI.input({ id: 'q_input', type: 'text', placeholder: 'Твой ответ…', value: s.answers[q.id] || '' })}</div>`;
    }

    const saveBtn = (q.question_type === 'select') ? '' :
      TaroUI.button('Сохранить', { onClick: `App.submitAnswer('${q.id}', document.getElementById('q_input').value)` });
    const skipBtn = (!q.is_mandatory) ?
      TaroUI.button('Пропустить', { variant: 'text', onClick: `App.skipQuestion('${q.id}')` }) : '';

    return TaroUI.screenHeader(q.title, { back: true }) +
      TaroUI.section(TaroUI.hint(q.description || 'Ответь как чувствуешь — неверных ответов нет.', { align: 'left' })) +
      field + saveBtn + skipBtn;
  },
};

// ── Утилиты форматирования ──
function _todayIso() {
  const d = new Date(Date.now() + 180 * 60000); // МСК
  return d.toISOString().slice(0, 10);
}
function _todayRu() {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const d = new Date(Date.now() + 180 * 60000);
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}
function _fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
function _fmtDateLong(iso) {
  if (!iso) return '';
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${days[dt.getUTCDay()]}, ${d} ${months[m - 1]}`;
}
function _fmtDateTime(iso) {
  if (!iso) return '';
  const s = String(iso);
  const datePart = _fmtDate(s);
  // created_at в UTC — переводим в МСК для отображения
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return datePart;
  const msk = new Date(d.getTime() + 180 * 60000);
  const hh = String(msk.getUTCHours()).padStart(2, '0');
  const mm = String(msk.getUTCMinutes()).padStart(2, '0');
  return `${datePart} ${hh}:${mm}`;
}
function _paragraphs(text) {
  return String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${TaroUI.esc(p)}</p>`).join('');
}

// Табы: карта дня — всегда первый и главный
const TABS = [
  { id: 'home', icon: '✦', label: 'Карта дня' },
  { id: 'history', icon: '☽', label: 'История' },
  { id: 'ask', icon: '✧', label: 'Спросить' },
  { id: 'shop', icon: '❖', label: 'Магазин' },
  { id: 'plans', icon: '★', label: 'Тарифы' },
  { id: 'profile', icon: '☉', label: 'Профиль' },
];

document.addEventListener('DOMContentLoaded', () => App.init());
