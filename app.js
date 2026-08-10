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
    readings: [],          // ответы на вопросы (локально, за сессию)
    testimonials: [],
    spheres: [],
    plans: [],
    loading: false,
    onboardingStep: 0,
    askSphere: null,       // выбранная сфера для вопроса
    drawing: false,        // анимация вытягивания карты
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
  }

  function setLoading(v) { state.loading = v; render(); }

  // ── Данные ──
  async function loadBase() {
    const [me, q] = await Promise.all([
      Api.call('me', {}),
      Api.call('questionnaire', {}),
    ]);
    if (me.ok) state.profile = me.profile;
    if (q.ok) {
      state.questions = q.questions;
      state.answers = q.answers;
      if (q.profile) state.profile = q.profile;
    }
    const [sp, pl, t] = await Promise.all([
      Api.call('spheres', {}),
      Api.call('plans', {}),
      Api.call('testimonials', {}),
    ]);
    if (sp.ok) state.spheres = sp.spheres;
    if (pl.ok) state.plans = pl.plans;
    if (t.ok) state.testimonials = t.testimonials || [];
  }

  async function loadTodayCard() {
    const res = await Api.call('card_today', { dry_run: true });
    if (res.ok) state.card = res.card;
  }

  async function loadHistory() {
    const res = await Api.call('card_history', { limit: 30 });
    if (res.ok) state.cardHistory = res.cards || [];
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
    tg?.HapticFeedback?.notificationOccurred('success');
    render();
    // анимация переворота после рендера
    requestAnimationFrame(() => {
      const el = document.querySelector('.flip-card');
      if (el) el.classList.add('flipped');
    });
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
      TaroUI.toast(res.error || 'Не получилось 🙈', { kind: 'error' });
      render();
      return;
    }
    state.readings.unshift(res.reading);
    tg?.HapticFeedback?.notificationOccurred('success');
    state.askSphere = null;
    render();
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
    startOnboarding, loadQuestionnaire,
  };
})();

// ── API-клиент ──
const Api = (() => {
  const base = window.TARO_API_BASE ||
    location.href.replace(/\/?$/, '/') + 'api';

  // Действия, которые НЕ безопасно повторять при сбое
  // (могут списать лимит или создать платёж дважды)
  const NO_RETRY = new Set(['ask_card', 'start_payment']);

  async function call(action, payload = {}, { retries = 1 } = {}) {
    try {
      const initData = tg?.initData || '';
      const headers = { 'Content-Type': 'application/json' };
      if (window.TARO_ANON_KEY) {
        headers['Authorization'] = 'B' + 'earer ' + window.TARO_ANON_KEY;
      }
      const res = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, initData, ...payload }),
      });
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
        <div class="tui-hint" style="margin-top:12px">Новая карта — каждый день после полуночи ✨</div>`;
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

    const body = `
      <div class="card-stage">
        <div class="flip-card flipped">
          <div class="flip-inner">
            <div class="flip-back"><div class="card-back-pattern">✦</div></div>
            <div class="flip-front ${c.reversed ? 'card-reversed' : ''}">
              ${TaroUI.tarotCard({ name: c.card_name, reversed: c.reversed, sphere: c.sphere_label })}
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
      <div class="tui-hint" style="margin-top:14px">
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

  // ═══ ИСТОРИЯ КАРТ ═══
  history(s) {
    const tabs = TaroUI.tabBar(TABS, 'history');
    if (s.loading) return TaroUI.spinner() + tabs;

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

    return TaroUI.screenHeader('История карт', { back: false }) +
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
        <p class="reading-text">${_paragraphs(r.interpretation || '')}</p>
      </div>`).join('');

    const body = `
      <div class="ask-intro">
        <h2 class="ask-title">Спроси у карт</h2>
        <p class="ask-sub">Задай вопрос, который сейчас важен — карты ответят лично для тебя. Бесплатно: один вопрос в день.</p>
      </div>
      <div class="ask-chips">${chips}</div>
      <div class="ask-field">
        <textarea class="tui-input" id="ask_input" rows="3" maxlength="500"
          placeholder="Например: что мне важно понять в отношениях прямо сейчас?"></textarea>
        <button class="tui-btn tui-btn-primary tui-btn-full" onclick="App.askCard()">Спросить карты ✦</button>
      </div>
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

    const body = `
      <div class="profile-hero">
        <div class="profile-avatar">✦</div>
        <div class="profile-name">${TaroUI.esc(p.name || 'Гость')}</div>
        <div class="profile-tier">${TaroUI.esc(tierLabel)}</div>
        ${p.tier === 'free' ? `<button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.go('plans')">Улучшить подписку</button>` : ''}
      </div>
      ${TaroUI.section(rows, { header: 'Твои данные' })}
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
function _paragraphs(text) {
  return String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${TaroUI.esc(p)}</p>`).join('');
}

// Табы: карта дня — всегда первый и главный
const TABS = [
  { id: 'home', icon: '✦', label: 'Карта дня' },
  { id: 'history', icon: '☽', label: 'История' },
  { id: 'ask', icon: '✧', label: 'Спросить' },
  { id: 'plans', icon: '❖', label: 'Тарифы' },
  { id: 'profile', icon: '☉', label: 'Профиль' },
];

document.addEventListener('DOMContentLoaded', () => App.init());
