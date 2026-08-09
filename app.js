/**
 * ТАРО Mini App — ядро SPA.
 *
 * Архитектура:
 *   App      — роутер экранов + глобальное состояние
 *   Api      — клиент к Supabase Edge Function (auth: Telegram initData)
 *   Screens  — чистые функции рендера на компонентах TaroUI
 *
 * Экраны: home (карта дня), spheres, questionnaire, plans, profile.
 * Стили — только дефолтные Telegram (см. taro-ui.css).
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
    card: null,          // карта дня сегодня
    spheres: [],
    plans: [],
    loading: false,
  };

  const root = () => document.getElementById('screen');

  // ── Роутер ──
  function go(screen, { push = true } = {}) {
    if (push && state.screen !== screen) state.history.push(state.screen);
    state.screen = screen;
    render();
    tg?.HapticFeedback?.selectionChanged();
  }

  function back() {
    const prev = state.history.pop();
    if (prev) { state.screen = prev; render(); }
  }

  // ── Рендер ──
  function render() {
    const el = root();
    if (!el) return;
    const screen = Screens[state.screen] ?? Screens.home;
    el.innerHTML = screen(state);
    tg?.ready();
  }

  function setLoading(v) { state.loading = v; render(); }

  // ── Действия экранов (вызываются из onclick) ──
  async function submitAnswer(questionId, value) {
    const res = await Api.call('answer', { question_id: questionId, value });
    if (!res.ok) { TaroUI.toast(res.error || 'Не получилось сохранить', { kind: 'error' }); return; }
    state.answers[questionId] = value;
    tg?.HapticFeedback?.notificationOccurred('success');
    await loadQuestionnaire();
  }

  async function skipQuestion(questionId) {
    const res = await Api.call('skip', { question_id: questionId });
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка'); return; }
    await loadQuestionnaire();
  }

  async function drawCard() {
    setLoading(true);
    const res = await Api.call('card_today', {});
    setLoading(false);
    if (!res.ok) { TaroUI.toast(res.error || 'Карты не ответили 🙈'); return; }
    state.card = res.card;
    if (res.newly_drawn) tg?.HapticFeedback?.notificationOccurred('success');
    render();
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

  async function loadStatic() {
    const [sp, pl] = await Promise.all([
      Api.call('spheres', {}),
      Api.call('plans', {}),
    ]);
    if (sp.ok) state.spheres = sp.spheres;
    if (pl.ok) state.plans = pl.plans;
    render();
  }

  // ── Инициализация ──
  async function init() {
    tg?.ready();
    tg?.expand();
    if (tg?.setHeaderColor) tg.setHeaderColor(tg.themeParams?.secondary_bg_color || '#f1f1f1');
    if (tg?.setBackgroundColor) tg.setBackgroundColor(tg.themeParams?.secondary_bg_color || '#f1f1f1');

    setLoading(true);
    const me = await Api.call('me', {});
    if (me.ok) state.profile = me.profile;
    await loadQuestionnaire();
    await loadStatic();
    // Карта дня, если уже есть сегодня
    const card = await Api.call('card_today', { dry_run: true });
    if (card.ok && card.card) state.card = card.card;
    setLoading(false);
    render();
  }

  return { state, go, back, render, init, setLoading,
    submitAnswer, skipQuestion, drawCard, loadQuestionnaire };
})();

// ── API-клиент ──
const Api = (() => {
  // API живёт там же, где статика (Edge Function), путь .../api.
  // window.TARO_API_BASE можно переопределить для локальной отладки.
  const base = window.TARO_API_BASE ||
    location.href.replace(/\/?$/, '/') + 'api';

  async function call(action, payload = {}) {
    try {
      const initData = tg?.initData || '';
      const headers = { 'Content-Type': 'application/json' };
      if (window.TARO_ANON_KEY) {
        headers['Authorization'] = '***' + window.TARO_ANON_KEY;
      }
      const res = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, initData, ...payload }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Нет связи с сервером' };
    }
  }
  return { call };
})();

// ── Экраны ──
const Screens = {

  home(s) {
    const tabs = TaroUI.tabBar(TABS, 'home');
    if (s.loading) return TaroUI.spinner() + tabs;

    const profile = s.profile;
    const name = profile?.name || 'друг';

    let body;
    if (!profile) {
      body = TaroUI.empty('Знакомимся…', 'Загружаем профиль');
    } else if (!s.card) {
      const mandatoryDone = profile.mandatory_done;
      body = TaroUI.section(
        TaroUI.hint(`Привет, ${TaroUI.esc(name)}! ✨`) +
        (mandatoryDone
          ? TaroUI.button('🃏 Вытянуть карту дня', { onClick: 'App.drawCard()' })
          : TaroUI.hint('Сначала заполни обязательные вопросы анкеты — и карты откроются.', { align: 'left' }) +
            TaroUI.button('📋 Заполнить анкету', { onClick: "App.go('questionnaire')" })
        )
      );
    } else {
      const c = s.card;
      body =
        TaroUI.section(TaroUI.tarotCard({ name: c.card_name, reversed: c.reversed, sphere: c.sphere_label })) +
        TaroUI.section(TaroUI.row('Позиция', c.reversed ? 'Перевёрнутая' : 'Прямая')) +
        (c.sphere_label ? TaroUI.section(TaroUI.row('Сфера', c.sphere_label)) : '') +
        TaroUI.section(TaroUI.hint(c.interpretation || '', { align: 'left' }),
          { header: 'Трактовка' }) +
        TaroUI.hint('Новая карта — каждый день после полуночи 🌙');
    }
    return TaroUI.screenHeader('Карта дня') + body + tabs;
  },

  spheres(s) {
    const tabs = TaroUI.tabBar(TABS, 'spheres');
    if (s.loading) return TaroUI.spinner() + tabs;
    const items = s.spheres.map((sp) => TaroUI.section(
      TaroUI.row(sp.label, '', { arrow: true, onClick: `TaroUI.toast('Расклады — скоро: их готовит Полина лично 🔮')` })
    )).join('');
    return TaroUI.screenHeader('Сферы') +
      (items || TaroUI.empty('Сферы загружаются')) +
      TaroUI.hint('5 сфер: любовь, финансы, здоровье, семья, предназначение') + tabs;
  },

  questionnaire(s) {
    const tabs = TaroUI.tabBar(TABS, 'questionnaire');
    if (s.loading) return TaroUI.spinner() + tabs;

    const questions = s.questions || [];
    const total = questions.length;
    const answered = questions.filter(q => s.answers[q.id]).length;

    const rows = questions.map((q) => {
      const val = Screens._displayValue(q, s.answers[q.id]);
      const answeredMark = val ? '✓' : (q.is_mandatory ? '•' : '');
      const click = `Screens._openQuestion('${q.id}')`;
      return TaroUI.row(
        `${answeredMark} ${q.title}`,
        val ? (val.length > 24 ? val.slice(0, 24) + '…' : val) : '—',
        { arrow: true, onClick: click }
      );
    }).join('');

    return TaroUI.screenHeader('Анкета') +
      TaroUI.section(rows, {
        header: `Ответов: ${answered} из ${total}`,
        footer: 'Обязательные помечены • — без них карта дня не откроется. Ответы можно менять в любой момент.',
      }) + tabs;
  },

  _displayValue(q, val) {
    if (!val) return '';
    // select: value → label
    if (q.question_type === 'select' && q.options?.length) {
      const opt = q.options.find(o => o.value === val);
      if (opt) return opt.label;
    }
    return String(val);
  },

  _openQuestion(id) {
    const q = (App.state.questions || []).find(x => x.id === id);
    if (!q) return;
    App.go('question_form', { push: true });
    App.state._editing = q;
    App.render();
  },

  question_form(s) {
    const q = s._editing;
    if (!q) { App.go('questionnaire', { push: false }); return ''; }

    let field;
    if (q.question_type === 'select' && q.options?.length) {
      field = q.options.map(opt => TaroUI.option(opt.label, {
        value: opt.value,
        selected: s.answers[q.id] === opt.value,
        onClick: `App.submitAnswer('${q.id}', '${TaroUI.esc(opt.value)}')`,
      })).join('');
      field = `<div class="tui-section">${field}</div>`;
    } else if (q.question_type === 'date') {
      field = `<div class="tui-section">
        ${TaroUI.input({ id: 'q_input', type: 'date', value: s.answers[q.id] || '' })}
      </div>`;
    } else if (q.question_type === 'textarea') {
      field = `<div class="tui-section">
        ${TaroUI.input({ id: 'q_input', type: 'textarea', placeholder: 'Расскажи своими словами…', value: s.answers[q.id] || '' })}
      </div>`;
    } else {
      field = `<div class="tui-section">
        ${TaroUI.input({ id: 'q_input', type: 'text', placeholder: 'Твой ответ…', value: s.answers[q.id] || '' })}
      </div>`;
    }

    const saveBtn = (q.question_type === 'select') ? '' :
      TaroUI.button('Сохранить', { onClick: `App.submitAnswer('${q.id}', document.getElementById('q_input').value)` });
    const skipBtn = (!q.is_mandatory) ?
      TaroUI.button('Пропустить', { variant: 'text', onClick: `App.skipQuestion('${q.id}')` }) : '';

    return TaroUI.screenHeader(q.title, { back: true }) +
      TaroUI.section(
        TaroUI.hint(q.description || 'Ответь как чувствуешь — неверных ответов нет.', { align: 'left' })
      ) + field + saveBtn + skipBtn;
  },

  plans(s) {
    const tabs = TaroUI.tabBar(TABS, 'plans');
    if (s.loading) return TaroUI.spinner() + tabs;

    const current = s.profile?.tier || 'free';
    const rows = (s.plans || []).map(p => {
      const active = p.code === current;
      const price = p.price_cents != null ? `$${(p.price_cents / 100).toFixed(0)}` : '';
      return TaroUI.row(
        `${p.title}${active ? ' · активен' : ''}`,
        price,
        { onClick: active ? '' : `TaroUI.toast('Оплата появится в фазе 2 — Telegram Stars ⭐')`, arrow: !active }
      );
    }).join('');

    return TaroUI.screenHeader('Тарифы') +
      (rows ? TaroUI.section(rows, { footer: 'Год = 2 месяца в подарок. Оплата: Telegram Stars, ЕРИП.' })
            : TaroUI.empty('Тарифы загружаются')) + tabs;
  },

  profile(s) {
    const tabs = TaroUI.tabBar(TABS, 'profile');
    if (s.loading) return TaroUI.spinner() + tabs;
    const p = s.profile;
    if (!p) return TaroUI.empty('Профиль не найден', 'Напиши боту /start') + tabs;

    const tierNames = { free: 'Free', basic: 'Basic $5', standard: 'Standard $10', premium: 'Premium $20' };
    const rows = [
      TaroUI.row('Имя', p.name || '—', { arrow: true, onClick: `Screens._openQuestion('name')` }),
      TaroUI.row('Дата рождения', p.birth_date || '—', { arrow: true, onClick: `Screens._openQuestion('birth_date')` }),
      TaroUI.row('Сфера', p.main_sphere_label || '—', { arrow: true, onClick: `Screens._openQuestion('main_sphere')` }),
      TaroUI.row('Тариф', tierNames[p.tier] || p.tier),
    ].join('');

    return TaroUI.screenHeader('Профиль') +
      TaroUI.section(rows, { header: 'Твои данные' }) +
      TaroUI.section(TaroUI.row('Канал Полины', 'открыть', {
        arrow: true, onClick: `window.open('https://t.me/tarolog_polina_marz_channel')`
      }), { header: 'Сообщество' }) + tabs;
  },
};

// Табы (дефолтный TG-стиль)
const TABS = [
  { id: 'home', icon: '🃏', label: 'Карта дня' },
  { id: 'spheres', icon: '🔮', label: 'Сферы' },
  { id: 'questionnaire', icon: '📋', label: 'Анкета' },
  { id: 'plans', icon: '💎', label: 'Тарифы' },
  { id: 'profile', icon: '👤', label: 'Профиль' },
];

document.addEventListener('DOMContentLoaded', () => App.init());
