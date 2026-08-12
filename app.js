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
    // ── Admin state ──
    adminToken: sessionStorage.getItem('admin_token') || null,
    adminTab: 'dashboard',  // dashboard | users | posts | slots | products | broadcasts | settings
    adminSidebarOpen: false,
    adminPosts: [],
    adminSlots: [],
    adminProducts: [],
    adminBroadcasts: [],
    adminEditing: null,    // currently editing item
    adminDashboard: null,  // metrics + events + chart
    adminUsers: [],
    adminUsersPage: 1,
    adminUsersTotal: 0,
    adminUsersPages: 1,
    adminUsersSearch: '',
    adminUsersTier: '',
    adminUserDetail: null, // selected user detail
    adminToasts: [],       // toast notifications
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
    state.lastBooking = b;
    // Переход к оплате через deep link
    if (b.deep_link) {
      if (tg?.openTelegramLink) tg.openTelegramLink(b.deep_link);
      else window.open(b.deep_link, '_blank');
    }
    go('booking_confirm', { push: false });
  }

  function openPolina() {
    // Воронка: всё через бота. Канал Полины — для контента, не для заказов.
    const url = 'https://t.me/tarolog_polina_marz_channel';
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
    state.loading = true; render();
    const res = await Api.call('pay_shop_item', { slug });
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

  async function shareReferral() {
    try {
      const res = await Api.call('referral_info');
      if (res.ok && res.share_link) {
        const shareText = `Получи 7 дней таро бесплатно ✦ ${res.share_link}`;
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(res.share_link)}&text=${encodeURIComponent(shareText)}`;
        if (tg?.openTelegramLink) tg.openTelegramLink(shareUrl);
        else window.open(shareUrl, '_blank');
      } else {
        TaroUI.toast('Ссылка скоро будет готова 🙏');
      }
    } catch (e) {
      TaroUI.toast('Не получилось — попробуй позже');
    }
  }

  function openChannel() {
    const url = 'https://t.me/tarolog_polina_marz_channel';
    if (tg?.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  }

  function shareCard() {
    const card = state.card;
    if (!card) return;
    const cardName = card.card_name || 'карта дня';
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent('https://t.me/TarotProto_bot')}&text=${encodeURIComponent('Моя карта дня — ' + cardName + ' ✦')}`;
    if (navigator.share) {
      navigator.share({
        title: 'Карта дня ТАРО',
        text: `Моя карта дня — ${cardName} ✦`,
        url: 'https://t.me/TarotProto_bot',
      }).catch(() => {});
    } else if (tg?.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, '_blank');
    }
    tg?.HapticFeedback?.selectionChanged();
  }

  // ── Инициализация ──
  async function init() {
    tg?.ready();
    tg?.expand();
    if (tg?.setHeaderColor) tg.setHeaderColor('#0d0c14');
    if (tg?.setBackgroundColor) tg.setBackgroundColor('#0d0c14');

    // ── Admin mode: #admin in URL → admin login/dashboard ──
    if (window.location.hash === '#admin' || window.location.hash === '#admin/') {
      if (state.adminToken) {
        go('admin_dashboard', { push: false });
        adminLoadTab('dashboard');
      } else {
        go('admin_login', { push: false });
      }
      return;
    }

    setLoading(true);
    try {
      await loadBase();
      if (state.profile?.mandatory_done) {
        await loadTodayCard();
        setLoading(false);
        // Deep link: #booking → сразу на экран записи к Полине
        if (window.location.hash === '#booking') {
          go('booking', { push: false });
        } else {
          go('home', { push: false });
        }
      } else if (state.profile) {
        setLoading(false);
        go('welcome', { push: false });
      } else {
        setLoading(false);
        go('home', { push: false }); // покажет ошибку соединения
      }
    } catch (e) {
      setLoading(false);
      render();
    }
  }

  // ── Admin: API helpers ──
  async function adminCall(action, payload = {}) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.TARO_ANON_KEY) {
        headers['Authorization'] = 'B' + 'earer ' + window.TARO_ANON_KEY;
      }
      const body = { action, admin_token: state.adminToken, ...payload };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(Api._base(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        let msg = 'Сбой на сервере';
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* */ }
        return { ok: false, error: msg };
      }
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Нет связи с сервером' };
    }
  }

  async function adminLogin(login, password) {
    state.loading = true; render();
    const res = await Api.call('admin_login', { login, password });
    state.loading = false;
    if (!res.ok) {
      TaroUI.toast(res.error || 'Не получилось 🙈', { kind: 'error' });
      render();
      return;
    }
    state.adminToken = res.token;
    sessionStorage.setItem('admin_token', res.token);
    tg?.HapticFeedback?.notificationOccurred('success');
    go('admin_dashboard', { push: false });
    await adminLoadTab('dashboard');
  }

  function adminLogout() {
    state.adminToken = null;
    sessionStorage.removeItem('admin_token');
    state.adminPosts = [];
    state.adminSlots = [];
    state.adminProducts = [];
    state.adminBroadcasts = [];
    state.adminDashboard = null;
    state.adminUsers = [];
    state.adminUserDetail = null;
    go('admin_login', { push: false });
  }

  // ── Toast system ──
  function adminToast(msg, kind = 'success') {
    const toast = { id: Date.now() + Math.random(), msg, kind, ts: Date.now() };
    state.adminToasts.push(toast);
    render();
    setTimeout(() => {
      state.adminToasts = state.adminToasts.filter(t => t.id !== toast.id);
      render();
    }, 4000);
  }

  function adminToggleSidebar() {
    state.adminSidebarOpen = !state.adminSidebarOpen;
    render();
  }

  async function adminLoadDashboard() {
    const res = await adminCall('admin_dashboard', {});
    if (res.ok) {
      state.adminDashboard = res;
      adminToast('Дашборд обновлён', 'info');
    } else {
      adminToast(res.error || 'Ошибка загрузки', 'error');
    }
    render();
  }

  async function adminLoadUsers(page) {
    if (page) state.adminUsersPage = page;
    const res = await adminCall('admin_users', {
      sub: 'list',
      page: state.adminUsersPage,
      per_page: 20,
      search: state.adminUsersSearch,
      tier: state.adminUsersTier,
    });
    if (res.ok) {
      state.adminUsers = res.users;
      state.adminUsersTotal = res.total;
      state.adminUsersPages = res.pages;
    } else {
      adminToast(res.error || 'Ошибка загрузки', 'error');
    }
    render();
  }

  async function adminSearchUsers() {
    const input = document.getElementById('user_search_input');
    state.adminUsersSearch = (input?.value || '').trim();
    state.adminUsersPage = 1;
    await adminLoadUsers();
  }

  function adminFilterTier(tier) {
    state.adminUsersTier = tier;
    state.adminUsersPage = 1;
    adminLoadUsers();
  }

  async function adminLoadUserDetail(profileId) {
    state.adminUserDetail = { _loading: true };
    render();
    const res = await adminCall('admin_users', { sub: 'detail', profile_id: profileId });
    if (res.ok) {
      state.adminUserDetail = res;
    } else {
      state.adminUserDetail = null;
      adminToast(res.error || 'Ошибка', 'error');
    }
    render();
  }

  function adminCloseUserDetail() {
    state.adminUserDetail = null;
    render();
  }

  function adminUsersPage(delta) {
    const next = state.adminUsersPage + delta;
    if (next < 1 || next > state.adminUsersPages) return;
    adminLoadUsers(next);
  }

  async function adminLoadTab(tab) {
    state.adminTab = tab;
    state.adminSidebarOpen = false;
    render();
    if (tab === 'dashboard') {
      if (!state.adminDashboard) await adminLoadDashboard();
    } else if (tab === 'users') {
      if (!state.adminUsers.length) await adminLoadUsers();
    } else if (tab === 'posts' && !state.adminPosts.length) {
      const res = await adminCall('admin_posts', { sub: 'list' });
      if (res.ok) state.adminPosts = res.posts || [];
    } else if (tab === 'slots' && !state.adminSlots.length) {
      const res = await adminCall('admin_slots', { sub: 'list' });
      if (res.ok) state.adminSlots = res.slots || [];
    } else if (tab === 'products' && !state.adminProducts.length) {
      const res = await adminCall('admin_products', { sub: 'list' });
      if (res.ok) state.adminProducts = res.products || [];
    } else if (tab === 'broadcasts' && !state.adminBroadcasts.length) {
      const res = await adminCall('admin_broadcasts', { sub: 'list' });
      if (res.ok) state.adminBroadcasts = res.broadcasts || [];
    }
    render();
  }

  async function adminSavePost(data) {
    state.loading = true; render();
    const sub = data.id ? 'update' : 'create';
    const res = await adminCall('admin_posts', { sub, ...data });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    // Reload list
    const list = await adminCall('admin_posts', { sub: 'list' });
    if (list.ok) state.adminPosts = list.posts;
    state.adminEditing = null;
    tg?.HapticFeedback?.notificationOccurred('success');
    TaroUI.toast('Сохранено ✨');
    go('admin_dashboard', { push: false });
    render();
  }

  async function adminDeletePost(id) {
    TaroUI.confirm('Удалить пост?', 'Это действие нельзя отменить', async () => {
      state.loading = true; render();
      const res = await adminCall('admin_posts', { sub: 'delete', id });
      state.loading = false;
      if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
      const list = await adminCall('admin_posts', { sub: 'list' });
      if (list.ok) state.adminPosts = list.posts;
      TaroUI.toast('Удалено');
      render();
    });
  }

  async function adminDeleteSlot(id) {
    state.loading = true; render();
    const res = await adminCall('admin_slots', { sub: 'delete', id });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    const list = await adminCall('admin_slots', { sub: 'list' });
    if (list.ok) state.adminSlots = list.slots;
    TaroUI.toast('Слот удалён');
    render();
  }

  async function adminSaveSlot(data) {
    state.loading = true; render();
    const res = await adminCall('admin_slots', { sub: 'create', ...data });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    const list = await adminCall('admin_slots', { sub: 'list' });
    if (list.ok) state.adminSlots = list.slots;
    state.adminEditing = null;
    TaroUI.toast('Слот добавлен ✨');
    render();
  }

  async function adminSaveProduct(data) {
    state.loading = true; render();
    const sub = data.id ? 'update' : 'create';
    const res = await adminCall('admin_products', { sub, ...data });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    const list = await adminCall('admin_products', { sub: 'list' });
    if (list.ok) state.adminProducts = list.products;
    state.adminEditing = null;
    TaroUI.toast('Сохранено ✨');
    render();
  }

  async function adminToggleProduct(id, isActive) {
    const res = await adminCall('admin_products', { sub: 'update', id, is_active: isActive });
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); return; }
    const list = await adminCall('admin_products', { sub: 'list' });
    if (list.ok) state.adminProducts = list.products;
    render();
  }

  async function adminSaveBroadcast(data) {
    state.loading = true; render();
    const res = await adminCall('admin_broadcasts', { sub: 'create', ...data });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    const list = await adminCall('admin_broadcasts', { sub: 'list' });
    if (list.ok) state.adminBroadcasts = list.broadcasts;
    state.adminEditing = null;
    TaroUI.toast('Рассылка создана ✨');
    render();
  }

  async function adminSendBroadcast(id) {
    state.loading = true; render();
    const res = await adminCall('admin_broadcasts', { sub: 'send', id });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    const list = await adminCall('admin_broadcasts', { sub: 'list' });
    if (list.ok) state.adminBroadcasts = list.broadcasts;
    TaroUI.toast('Рассылка запущена ✨');
    render();
  }

  async function adminChangeCredentials() {
    const newLogin = (document.getElementById('adm_new_login')?.value || '').trim();
    const newPassword = (document.getElementById('adm_new_pass')?.value || '').trim();
    if (!newLogin && !newPassword) { TaroUI.toast('Укажи логин или пароль'); return; }
    state.loading = true; render();
    const res = await adminCall('admin_change_credentials', { new_login: newLogin, new_password: newPassword });
    state.loading = false;
    if (!res.ok) { TaroUI.toast(res.error || 'Ошибка', { kind: 'error' }); render(); return; }
    TaroUI.toast(res.note || 'Инструкция отправлена');
    render();
  }

  function adminEdit(item) {
    state.adminEditing = item;
    render();
  }

  function adminSetTab(tab) {
    adminLoadTab(tab);
  }

  return {
    state, go, back, render, init, setLoading,
    submitAnswer, skipQuestion, drawCard, reviewCard,
    setAskSphere, askCard, payPlan, openChannel,
    startOnboarding, loadQuestionnaire, setHistTab, saveCardTime,
    loadShopItems, loadReadingServices, loadBookingSlots, bookSlot, openPolina,
    payShopItem, shareCard,
    // Admin
    adminLogin, adminLogout, adminLoadTab, adminSavePost, adminDeletePost,
    adminDeleteSlot, adminSaveSlot, adminSaveProduct, adminToggleProduct,
    adminSaveBroadcast, adminSendBroadcast, adminEdit, adminSetTab,
    adminChangeCredentials,
    // Admin v2
    adminToast, adminToggleSidebar, adminLoadDashboard, adminLoadUsers,
    adminSearchUsers, adminFilterTier, adminLoadUserDetail, adminCloseUserDetail,
    adminUsersPage,
  };
})();

// ── API-клиент ──
const Api = (() => {
  const base = window.TARO_API_BASE ||
    location.href.replace(/\/?$/, '/') + 'api';

  // Действия, которые НЕ безопасно повторять при сбое
  // (могут списать лимит или создать платёж дважды)
  const NO_RETRY = new Set(['ask_card', 'start_payment', 'pay_shop_item']);
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
  return { call, _base: () => base };
})();

// ── Экраны ──
const Screens = {

  // ═══ ПРИВЕТСТВЕННЫЙ ЭКРАН ═══
  welcome(s) {
    const body = `
      <div class="welcome">
        <div class="welcome-icon">✦</div>
        <h1 class="welcome-title">Добро пожаловать</h1>
        <p class="welcome-text">Я — Полина. Карты помогут услышать себя. Ответь на 3 вопроса — и карты заговорят с тобой лично.</p>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow" onclick="App.startOnboarding()">Начать ✦</button>
      </div>`;
    return TaroUI.screenHeader('Добро пожаловать', { back: false }) + body;
  },

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
        <div class="next-step-title">Личный расклад у Полины · от $10</div>
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
      <button class="share-btn" onclick="App.shareCard()">Поделиться картой 📤</button>
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
    if (s.loading) return TaroUI.spinner();

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
    return TaroUI.screenHeader('Вопрос к картам', { back: true }) + body;
  },

  // ═══ ТАРИФЫ + ОТЗЫВЫ ═══
  plans(s) {
    if (s.loading) return TaroUI.spinner();

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
    return TaroUI.screenHeader('Тарифы', { back: true }) + body;
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
        TaroUI.row('Тарифы и подписки', p.tier === 'free' ? 'от $5' : 'изменить', { arrow: true, onClick: `App.go('plans')` }),
        { header: 'Подписка' }
      )}
      ${TaroUI.section(
        TaroUI.row('Полная анкета', 'изменить ответы', { arrow: true, onClick: `App.go('questionnaire')` }) +
        TaroUI.row('Канал Полины', 'открыть', { arrow: true, onClick: 'App.openChannel()' }),
        { header: 'Ещё' }
      )}
      <div class="referral-block" id="referral-block">
        <div class="referral-title">🎁 Подари подруге 7 дней таро</div>
        <div class="referral-desc">Поделись ссылкой — подруга получит 7 дней бесплатно, а ты — месяц $10 после её первой оплаты.</div>
        <button class="tui-btn tui-btn-glow tui-btn-full" id="referral-btn" onclick="App.shareReferral()">Поделиться ссылкой ✦</button>
      </div>`;

    return TaroUI.screenHeader('Профиль') + body + tabs;
  },

  // ═══ АНКЕТА (список всех вопросов) ═══
  questionnaire(s) {
    if (s.loading) return TaroUI.spinner();

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
      });
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
          <div class="polina-cta-title">Записаться на расклад · от $10</div>
          <div class="polina-cta-sub">Живой разбор твоей ситуации — Полина разберёт твою ситуацию</div>
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
        <button class="tui-btn tui-btn-secondary tui-btn-full" onclick="App.openPolina()">Канал Полины ›</button>
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
        Нужна срочная консультация? +50% — <span class="linklike" onclick="App.openPolina()">Канал Полины ›</span>
      </div>`;

    return TaroUI.screenHeader('Запись к Полине', { back: true }) + body;
  },

  // ═══ ПОДТВЕРЖДЕНИЕ ЗАПИСИ ═══
  booking_confirm(s) {
    const b = s.lastBooking || {};
    const slotDate = b.slot_date ? _fmtDateLong(b.slot_date) : '';
    const slotTime = b.slot_time ? String(b.slot_time).slice(0, 5) : '';
    const body = `
      <div class="confirm-screen">
        <div class="confirm-icon">✓</div>
        <h2 class="confirm-title">Запись создана</h2>
        <div class="confirm-card">
          <div class="confirm-row"><span class="confirm-label">Услуга</span><span class="confirm-val">${TaroUI.esc(b.service_name || 'Личный расклад')}</span></div>
          <div class="confirm-row"><span class="confirm-label">Дата</span><span class="confirm-val">${TaroUI.esc(slotDate)}</span></div>
          <div class="confirm-row"><span class="confirm-label">Время</span><span class="confirm-val">${TaroUI.esc(slotTime)} МСК</span></div>
          <div class="confirm-row"><span class="confirm-label">Готовность</span><span class="confirm-val">~3 дня после оплаты</span></div>
          ${b.stars ? `<div class="confirm-row"><span class="confirm-label">К оплате</span><span class="confirm-val">${b.stars} ⭐</span></div>` : ''}
        </div>
        <p class="confirm-hint">Полина свяжется с тобой для подтверждения. Оплата — через Telegram Stars.</p>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow" onclick="App.go('home', { push: false })">Готово ✦</button>
      </div>`;
    return TaroUI.screenHeader('Готово', { back: false }) + body;
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

  // ══════════════════════════════════════════
  // ═══ ADMIN: ЛОГИН ═══
  // ══════════════════════════════════════════
  admin_login(s) {
    if (s.loading) return TaroUI.spinner();
    const body = `
      <div class="admin-login-wrap">
        <div class="admin-login-icon">✦</div>
        <h2 class="admin-login-title">Админ-панель</h2>
        <p class="admin-login-sub">Вход для владельца</p>
        <div class="admin-form">
          <input class="tui-input admin-input" id="admin_login_field" type="text" placeholder="Логин" autocomplete="username">
          <input class="tui-input admin-input" id="admin_password_field" type="password" placeholder="Пароль" autocomplete="current-password">
          <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow"
            onclick="App.adminLogin(document.getElementById('admin_login_field').value, document.getElementById('admin_password_field').value)">
            Войти ✦
          </button>
        </div>
        <div class="tui-hint" style="margin-top:16px;text-align:center">
          Только для владельца. Регистрации нет.
        </div>
      </div>`;
    return body;
  },

  // ═══ ADMIN: ДАШБОРД ═══
  admin_dashboard(s) {
    if (!s.adminToken) { App.go('admin_login', { push: false }); return ''; }

    const navItems = [
      { id: 'dashboard', icon: '▣', label: 'Дашборд' },
      { id: 'users', icon: '○', label: 'Пользователи' },
      { id: 'posts', icon: '✦', label: 'Блог' },
      { id: 'slots', icon: '☽', label: 'Слоты' },
      { id: 'products', icon: '❖', label: 'Товары' },
      { id: 'broadcasts', icon: '✧', label: 'Рассылки' },
      { id: 'settings', icon: '☉', label: 'Настройки' },
    ];

    const sidebarHtml = `<div class="adm-sidebar ${s.adminSidebarOpen ? 'adm-sidebar-open' : ''}" id="adm_sidebar">
      <div class="adm-sidebar-header">
        <div class="adm-sidebar-logo">✦</div>
        <div class="adm-sidebar-title">ТАРО Админ</div>
      </div>
      <nav class="adm-sidebar-nav">
        ${navItems.map(n => `<div class="adm-nav-item ${s.adminTab === n.id ? 'adm-nav-active' : ''}" onclick="App.adminLoadTab('${n.id}')">
          <span class="adm-nav-icon">${n.icon}</span>
          <span class="adm-nav-label">${n.label}</span>
        </div>`).join('')}
      </nav>
      <div class="adm-sidebar-footer">
        <div class="adm-sidebar-user">
          <div class="adm-sidebar-avatar">✦</div>
          <div class="adm-sidebar-userinfo">
            <div class="adm-sidebar-name">Полина</div>
            <div class="adm-sidebar-role">Владелец</div>
          </div>
        </div>
        <div class="adm-sidebar-logout" onclick="App.adminLogout()">Выйти</div>
      </div>
    </div>
    <div class="adm-sidebar-overlay ${s.adminSidebarOpen ? 'adm-overlay-show' : ''}" onclick="App.adminToggleSidebar()"></div>`;

    const topbarHtml = `<div class="adm-topbar">
      <div class="adm-topbar-left">
        <button class="adm-hamburger" onclick="App.adminToggleSidebar()">☰</button>
        <span class="adm-topbar-title">${TaroUI.esc(navItems.find(n => n.id === s.adminTab)?.label || 'Дашборд')}</span>
      </div>
      <div class="adm-topbar-right">
        <div class="adm-topbar-avatar">✦</div>
        <span class="adm-topbar-name">Полина</span>
        <button class="adm-topbar-logout" onclick="App.adminLogout()">Выйти</button>
      </div>
    </div>`;

    let content = '';
    if (s.adminTab === 'dashboard') content = Screens._adminDashboardHome(s);
    else if (s.adminTab === 'users') content = Screens._adminUsers(s);
    else if (s.adminTab === 'posts') content = Screens._adminPosts(s);
    else if (s.adminTab === 'slots') content = Screens._adminSlots(s);
    else if (s.adminTab === 'products') content = Screens._adminProducts(s);
    else if (s.adminTab === 'broadcasts') content = Screens._adminBroadcasts(s);
    else if (s.adminTab === 'settings') content = Screens._adminSettings(s);

    // Toast container
    const toastsHtml = `<div class="adm-toasts">
      ${s.adminToasts.map(t => `<div class="adm-toast adm-toast-${t.kind}">
        <span class="adm-toast-icon">${t.kind === 'success' ? '✓' : t.kind === 'error' ? '✕' : 'ⓘ'}</span>
        <span class="adm-toast-msg">${TaroUI.esc(t.msg)}</span>
      </div>`).join('')}
    </div>`;

    return `<div class="adm-layout">${sidebarHtml}
      <div class="adm-main">
        ${topbarHtml}
        <div class="adm-content">${content}</div>
      </div>
    </div>${toastsHtml}`;
  },

  // ═══ ADMIN: ДАШБОРД — главная ═══
  _adminDashboardHome(s) {
    const d = s.adminDashboard;
    if (!d) return TaroUI.spinner();
    const m = d.metrics;

    const tierLabel = { free: 'Free', basic: '$5', standard: '$10', premium: '$20' };
    const tierBadges = Object.entries(m.tier_breakdown || {})
      .map(([tier, count]) => `<span class="adm-tier-chip">${tierLabel[tier] || tier}: <b>${count}</b></span>`)
      .join('');

    // Bar chart: registrations by day
    const chartData = d.registrations_by_day || [];
    const maxVal = Math.max(1, ...chartData.map(d => d.count));
    const chartBars = chartData.map((d, i) => {
      const h = Math.max(2, (d.count / maxVal) * 120);
      const dayLabel = d.date.slice(8) + '.' + d.date.slice(5, 7);
      return `<div class="adm-chart-bar-wrap" title="${dayLabel}: ${d.count}">
        <div class="adm-chart-bar-val">${d.count}</div>
        <div class="adm-chart-bar" style="height:${h}px"></div>
        <div class="adm-chart-bar-label">${dayLabel}</div>
      </div>`;
    }).join('');

    // Event icons
    const eventIcon = { user: '○', card: '✦', booking: '☽' };
    const events = (d.events || []).slice(0, 10).map(e => `
      <div class="adm-event">
        <span class="adm-event-icon">${eventIcon[e.type] || '•'}</span>
        <span class="adm-event-text">${TaroUI.esc(e.text)}</span>
        <span class="adm-event-time">${_fmtDate(String(e.at).slice(0, 10))}</span>
      </div>`).join('');

    return `
      <div class="adm-metrics-grid">
        <div class="adm-metric-card">
          <div class="adm-metric-icon">○</div>
          <div class="adm-metric-val">${m.total_users}</div>
          <div class="adm-metric-label">Всего пользователей</div>
        </div>
        <div class="adm-metric-card">
          <div class="adm-metric-icon">✦</div>
          <div class="adm-metric-val">${m.active_subscriptions}</div>
          <div class="adm-metric-label">Активных подписок</div>
          <div class="adm-metric-sub">${tierBadges}</div>
        </div>
        <div class="adm-metric-card">
          <div class="adm-metric-icon">☽</div>
          <div class="adm-metric-val">${m.cards_today}</div>
          <div class="adm-metric-label">Карт дня сегодня</div>
        </div>
        <div class="adm-metric-card">
          <div class="adm-metric-icon">☾</div>
          <div class="adm-metric-val">${m.slots_free}<span class="adm-metric-sep">/</span>${m.slots_booked}</div>
          <div class="adm-metric-label">Слоты свободно/занято</div>
        </div>
        <div class="adm-metric-card">
          <div class="adm-metric-icon">✧</div>
          <div class="adm-metric-val">${m.broadcasts_sent}</div>
          <div class="adm-metric-label">Рассылок отправлено</div>
        </div>
        <div class="adm-metric-card">
          <div class="adm-metric-icon">❖</div>
          <div class="adm-metric-val">${m.blog_posts}</div>
          <div class="adm-metric-label">Статей в блоге</div>
          <div class="adm-metric-sub">${m.blog_published} опубликовано</div>
        </div>
      </div>
      <div class="adm-dashboard-row">
        <div class="adm-chart-section">
          <div class="adm-section-title">Регистрации по дням</div>
          <div class="adm-chart">${chartBars}</div>
        </div>
        <div class="adm-events-section">
          <div class="adm-section-title">Последние события</div>
          <div class="adm-events-list">${events || '<div class="adm-empty">Пока нет событий</div>'}</div>
        </div>
      </div>
      <button class="tui-btn tui-btn-secondary tui-btn-small adm-refresh-btn" onclick="App.adminLoadDashboard()">↻ Обновить</button>`;
  },

  // ═══ ADMIN: ПОЛЬЗОВАТЕЛИ ═══
  _adminUsers(s) {
    if (s.adminUserDetail) return Screens._adminUserDetailModal(s);

    const tierLabel = { free: 'Free', basic: 'Basic', standard: 'Standard', premium: 'Premium' };
    const tierColors = { free: 'adm-badge-dim', basic: 'adm-badge-gold', standard: 'adm-badge-gold', premium: 'admin-badge-green' };

    const rows = (s.adminUsers || []).map(u => `
      <tr class="adm-table-row" onclick="App.adminLoadUserDetail('${u.id}')">
        <td class="adm-cell-name">${TaroUI.esc(u.first_name || '—')}</td>
        <td>${TaroUI.esc(u.username || '—')}</td>
        <td><span class="adm-badge ${tierColors[u.tier] || 'adm-badge-dim'}">${tierLabel[u.tier] || u.tier || 'free'}</span></td>
        <td>${TaroUI.esc(u.locale || '—')}</td>
        <td>${u.created_at ? _fmtDate(u.created_at.slice(0, 10)) : '—'}</td>
        <td>${u.card_count || 0}</td>
      </tr>`).join('');

    const tierFilterBtns = ['', 'free', 'basic', 'standard', 'premium'].map(t =>
      `<button class="adm-filter-btn ${s.adminUsersTier === t ? 'adm-filter-active' : ''}" onclick="App.adminFilterTier('${t}')">${t ? tierLabel[t] : 'Все'}</button>`
    ).join('');

    return `
      <div class="adm-section-header">
        <span>Пользователи · ${s.adminUsersTotal}</span>
        <div class="adm-search-row">
          <input class="tui-input adm-search-input" id="user_search_input" type="text"
            placeholder="Поиск по имени/username..."
            value="${TaroUI.esc(s.adminUsersSearch)}"
            onkeydown="if(event.key==='Enter')App.adminSearchUsers()">
          <button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.adminSearchUsers()">Найти</button>
        </div>
      </div>
      <div class="adm-filter-row">${tierFilterBtns}</div>
      ${rows ? `<div class="adm-table-wrap">
        <table class="adm-table">
          <thead><tr>
            <th>Имя</th><th>Username</th><th>Tier</th><th>Локаль</th><th>Регистрация</th><th>Карт</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : TaroUI.spinner()}
      ${s.adminUsersPages > 1 ? `<div class="adm-pagination">
        <button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.adminUsersPage(-1)" ${s.adminUsersPage <= 1 ? 'disabled' : ''}>‹ Назад</button>
        <span class="adm-pagination-info">Стр. ${s.adminUsersPage} из ${s.adminUsersPages}</span>
        <button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.adminUsersPage(1)" ${s.adminUsersPage >= s.adminUsersPages ? 'disabled' : ''}>Дальше ›</button>
      </div>` : ''}`;
  },

  // ═══ ADMIN: ДЕТАЛИ ПОЛЬЗОВАТЕЛЯ (модалка) ═══
  _adminUserDetailModal(s) {
    const d = s.adminUserDetail;
    if (d._loading) return TaroUI.spinner();
    const p = d.profile || {};

    const tierLabel = { free: 'Free', basic: 'Basic', standard: 'Standard', premium: 'Premium' };
    const sphereLabels = { love: 'Любовь', finance: 'Финансы', health: 'Здоровье', family: 'Семья', purpose: 'Предназначение' };

    const cardsHtml = (d.cards || []).map(c => `
      <div class="adm-detail-row">
        <span class="adm-detail-icon">${c.reversed ? '⥁' : '✦'}</span>
        <span class="adm-detail-main">${TaroUI.esc(c.card_name || '—')}</span>
        <span class="adm-detail-date">${_fmtDate(c.draw_date)}</span>
      </div>`).join('');

    const paymentsHtml = (d.payments || []).map(p => `
      <div class="adm-detail-row">
        <span class="adm-detail-icon">$</span>
        <span class="adm-detail-main">${(p.amount_cents / 100).toFixed(2)}$ · ${p.item_type || '—'}</span>
        <span class="adm-detail-status">${p.status}</span>
      </div>`).join('');

    const bookingsHtml = (d.bookings || []).map(b => `
      <div class="adm-detail-row">
        <span class="adm-detail-icon">☽</span>
        <span class="adm-detail-main">${_fmtDate(b.date)} ${String(b.time).slice(0,5)}</span>
        <span class="adm-detail-status">${b.status}</span>
      </div>`).join('');

    const questHtml = (d.questionnaire || []).map(q => `
      <div class="adm-detail-quest">
        <div class="adm-detail-quest-q">${TaroUI.esc(q.question || q.key || '—')}</div>
        <div class="adm-detail-quest-a">${TaroUI.esc(q.answer || '—')}</div>
      </div>`).join('');

    return `
      <div class="adm-modal-backdrop" onclick="App.adminCloseUserDetail()">
        <div class="adm-modal" onclick="event.stopPropagation()">
          <div class="adm-modal-header">
            <span class="adm-modal-title">${TaroUI.esc(p.first_name || 'Пользователь')}</span>
            <button class="adm-modal-close" onclick="App.adminCloseUserDetail()">✕</button>
          </div>
          <div class="adm-modal-body">
            <div class="adm-detail-profile">
              <div class="adm-detail-avatar">✦</div>
              <div class="adm-detail-info">
                <div class="adm-detail-name">${TaroUI.esc(p.first_name || '—')}</div>
                <div class="adm-detail-meta">
                  @${TaroUI.esc(p.username || '—')} · 
                  <span class="adm-badge ${tierColors[p.tier] || 'adm-badge-dim'}">${tierLabel[p.tier] || 'free'}</span>
                  ${p.is_annual ? ' · годовая' : ''}
                </div>
                <div class="adm-detail-meta2">
                  ${p.locale ? 'Язык: ' + TaroUI.esc(p.locale) : ''}
                  ${p.birth_date ? ' · Родился: ' + _fmtDate(p.birth_date) : ''}
                  ${p.priority_sphere ? ' · Сфера: ' + TaroUI.esc(sphereLabels[p.priority_sphere] || p.priority_sphere) : ''}
                </div>
                <div class="adm-detail-meta2">
                  Регистрация: ${p.created_at ? _fmtDate(p.created_at.slice(0,10)) : '—'}
                  ${p.card_delivery_time ? ' · Карта дня в ' + p.card_delivery_time + ' МСК' : ''}
                </div>
              </div>
            </div>
            <div class="adm-detail-section">
              <div class="adm-detail-section-title">Карты дня (${(d.cards || []).length})</div>
              ${cardsHtml || '<div class="adm-empty">Нет карт</div>'}
            </div>
            <div class="adm-detail-section">
              <div class="adm-detail-section-title">Платежи (${(d.payments || []).length})</div>
              ${paymentsHtml || '<div class="adm-empty">Нет платежей</div>'}
            </div>
            <div class="adm-detail-section">
              <div class="adm-detail-section-title">Записи (${(d.bookings || []).length})</div>
              ${bookingsHtml || '<div class="adm-empty">Нет записей</div>'}
            </div>
            <div class="adm-detail-section">
              <div class="adm-detail-section-title">Анкета</div>
              ${questHtml || '<div class="adm-empty">Нет ответов</div>'}
            </div>
          </div>
        </div>
      </div>`;
  },

  // ═══ ADMIN: БЛОГ (посты) ═══
  _adminPosts(s) {
    if (s.adminEditing && s.adminEditing._type === 'post') {
      return Screens._adminPostForm(s);
    }
    const posts = s.adminPosts || [];
    const statusBadge = (st) => {
      const cls = st === 'published' ? 'admin-badge-green' : st === 'scheduled' ? 'admin-badge-gold' : 'admin-badge-dim';
      return `<span class="admin-badge ${cls}">${st}</span>`;
    };
    const items = posts.map(p => `
      <div class="admin-item">
        <div class="admin-item-row" onclick="this.classList.toggle('open')">
          <div class="admin-item-emoji">${TaroUI.esc(p.cover_emoji || '✦')}</div>
          <div class="admin-item-main">
            <div class="admin-item-title">${TaroUI.esc(p.title)}</div>
            <div class="admin-item-meta">${statusBadge(p.status)} · ${p.scheduled_at ? _fmtDate(p.scheduled_at.slice(0,10)) + ' ' + String(p.scheduled_at).slice(11,16) : p.published_at ? _fmtDate(p.published_at.slice(0,10)) : '—'}</div>
          </div>
          <div class="admin-item-chevron">›</div>
        </div>
        <div class="admin-item-actions">
          <button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.adminEdit({...${JSON.stringify(p).replace(/"/g,'&quot;')}, _type:'post'})">Редактировать</button>
          <button class="tui-btn tui-btn-primary tui-btn-small" onclick="App.adminSavePost({id:'${p.id}', status:'published'})">Опубликовать</button>
          <button class="tui-btn tui-btn-text tui-btn-small admin-danger" onclick="App.adminDeletePost('${p.id}')">Удалить</button>
        </div>
      </div>
    `).join('');

    return `
      <div class="admin-section-header">
        <span>Блог — публикации</span>
        <button class="tui-btn tui-btn-primary tui-btn-small" onclick="App.adminEdit({_type:'post', status:'draft'})">+ Новый пост</button>
      </div>
      ${items ? `<div class="admin-list">${items}</div>` : TaroUI.empty('Постов нет', 'Создай первый пост')}`;
  },

  _adminPostForm(s) {
    const p = s.adminEditing || {};
    const isEdit = !!p.id;
    const body = `
      <div class="admin-form-wrap">
        <div class="admin-form-back" onclick="App.adminEdit(null)">‹ Назад к списку</div>
        <h3 class="admin-form-title">${isEdit ? 'Редактировать пост' : 'Новый пост'}</h3>
        <div class="admin-form-field">
          <label class="admin-label">Заголовок</label>
          <input class="tui-input" id="post_title" type="text" value="${TaroUI.esc(p.title || '')}" placeholder="Заголовок поста">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Slug (URL)</label>
          <input class="tui-input" id="post_slug" type="text" value="${TaroUI.esc(p.slug || '')}" placeholder="auto">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Эмодзи-обложка</label>
          <input class="tui-input" id="post_emoji" type="text" value="${TaroUI.esc(p.cover_emoji || '✦')}" maxlength="2">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Краткое описание</label>
          <textarea class="tui-input" id="post_excerpt" rows="2" placeholder="Анонс">${TaroUI.esc(p.excerpt || '')}</textarea>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Текст (markdown)</label>
          <textarea class="tui-input admin-textarea-md" id="post_body" rows="12" placeholder="Текст поста в markdown...">${TaroUI.esc(p.body_md || p.body || '')}</textarea>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Статус</label>
          <select class="tui-input" id="post_status">
            <option value="draft" ${p.status === 'draft' ? 'selected' : ''}>Черновик</option>
            <option value="scheduled" ${p.status === 'scheduled' ? 'selected' : ''}>Запланирован</option>
            <option value="published" ${p.status === 'published' ? 'selected' : ''}>Опубликован</option>
          </select>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Дата/время публикации (для scheduled)</label>
          <input class="tui-input" id="post_scheduled" type="datetime-local" value="${p.scheduled_at ? p.scheduled_at.slice(0,16) : ''}">
        </div>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow"
          onclick="App.adminSavePost({
            id: ${p.id ? `'${p.id}'` : 'null'},
            title: document.getElementById('post_title').value,
            slug: document.getElementById('post_slug').value,
            cover_emoji: document.getElementById('post_emoji').value,
            excerpt: document.getElementById('post_excerpt').value,
            body: document.getElementById('post_body').value,
            status: document.getElementById('post_status').value,
            scheduled_at: document.getElementById('post_scheduled').value || null
          })">
          Сохранить ✦
        </button>
      </div>`;
    return body;
  },

  // ═══ ADMIN: СЛОТЫ ═══
  _adminSlots(s) {
    if (s.adminEditing && s.adminEditing._type === 'slot') {
      return Screens._adminSlotForm(s);
    }
    const slots = s.adminSlots || [];
    // Group by date
    const byDate = {};
    for (const sl of slots) {
      if (!byDate[sl.date]) byDate[sl.date] = [];
      byDate[sl.date].push(sl);
    }
    const dates = Object.keys(byDate).sort();

    const dateCard = (date) => {
      const daySlots = byDate[date];
      const slotItems = daySlots.map(sl => {
        const timeStr = String(sl.time).slice(0, 5);
        const isBooked = sl.status === 'booked';
        const isFree = sl.status === 'free';
        const statusCls = isBooked ? 'admin-slot-booked' : 'admin-slot-free';
        const bookingInfo = isBooked ? `
          <div class="admin-slot-info">
            ${sl.profile ? TaroUI.esc(sl.profile.first_name || sl.profile.username || '—') : '—'}
            · ${sl.service ? TaroUI.esc(sl.service.name) : '—'}
            ${sl.payment ? ` · ${sl.payment.status === 'paid' ? '✓ оплачено' : '⏳ не оплачено'}` : ''}
          </div>` : '';
        return `<div class="admin-slot-item ${statusCls}">
          <div class="admin-slot-time">${timeStr}</div>
          <div class="admin-slot-details">
            <span class="admin-slot-status">${isBooked ? 'Занят' : 'Свободен'}</span>
            ${sl.service ? `<span class="admin-slot-service">${TaroUI.esc(sl.service.name)}</span>` : ''}
            ${bookingInfo}
          </div>
          ${isFree ? `<button class="tui-btn tui-btn-text tui-btn-small admin-danger" onclick="App.adminDeleteSlot('${sl.id}')">Удалить</button>` : ''}
        </div>`;
      }).join('');
      return `<div class="admin-date-group">
        <div class="admin-date-label">${_fmtDateLong(date)}</div>
        ${slotItems}
      </div>`;
    };

    return `
      <div class="admin-section-header">
        <span>Слоты записи (14 дней)</span>
        <button class="tui-btn tui-btn-primary tui-btn-small" onclick="App.adminEdit({_type:'slot'})">+ Добавить слот</button>
      </div>
      ${dates.length ? dates.map(dateCard).join('') : TaroUI.empty('Слотов нет', 'Добавь первый слот для записи')}`;
  },

  _adminSlotForm(s) {
    const today = _todayIso();
    return `
      <div class="admin-form-wrap">
        <div class="admin-form-back" onclick="App.adminEdit(null)">‹ Назад</div>
        <h3 class="admin-form-title">Новый слот</h3>
        <div class="admin-form-field">
          <label class="admin-label">Дата</label>
          <input class="tui-input" id="slot_date" type="date" value="${today}">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Время (МСК)</label>
          <input class="tui-input" id="slot_time" type="time" value="12:00">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Тип</label>
          <select class="tui-input" id="slot_type">
            <option value="real">Обычный</option>
            <option value="annual_only">Только для премиум</option>
          </select>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Длительность (мин)</label>
          <input class="tui-input" id="slot_duration" type="number" value="30" min="15" max="120">
        </div>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow"
          onclick="App.adminSaveSlot({
            slot_date: document.getElementById('slot_date').value,
            starts_at: document.getElementById('slot_time').value,
            slot_type: document.getElementById('slot_type').value,
            duration_min: document.getElementById('slot_duration').value
          })">
          Добавить слот ✦
        </button>
      </div>`;
  },

  // ═══ ADMIN: ТОВАРЫ ═══
  _adminProducts(s) {
    if (s.adminEditing && s.adminEditing._type === 'product') {
      return Screens._adminProductForm(s);
    }
    const products = s.adminProducts || [];
    const typeLabel = { deck: 'Колоды', service: 'Услуги', goods: 'Товары' };
    const groups = {};
    for (const p of products) {
      const t = p.product_type || 'goods';
      if (!groups[t]) groups[t] = [];
      groups[t].push(p);
    }

    const itemCard = (p) => {
      const price = `$${(p.price_usd_cents / 100).toFixed(2)}`;
      const active = p.is_active;
      return `<div class="admin-item">
        <div class="admin-item-row">
          <div class="admin-item-emoji">❖</div>
          <div class="admin-item-main">
            <div class="admin-item-title">${TaroUI.esc(p.name_ru)}</div>
            <div class="admin-item-meta">${price} · ${active ? 'виден' : 'скрыт'}</div>
          </div>
        </div>
        <div class="admin-item-actions">
          <button class="tui-btn tui-btn-secondary tui-btn-small" onclick="App.adminEdit({...${JSON.stringify(p).replace(/"/g,'&quot;')}, _type:'product'})">Изменить</button>
          <button class="tui-btn tui-btn-${active ? 'text' : 'primary'} tui-btn-small" onclick="App.adminToggleProduct('${p.id}', ${!active})">${active ? 'Скрыть' : 'Показать'}</button>
        </div>
      </div>`;
    };

    let html = `<div class="admin-section-header">
      <span>Товары магазина</span>
      <button class="tui-btn tui-btn-primary tui-btn-small" onclick="App.adminEdit({_type:'product', product_type:'goods', is_active:true, price_usd_cents:0})">+ Добавить товар</button>
    </div>`;

    for (const [type, items] of Object.entries(groups)) {
      html += `<div class="admin-group-title">${typeLabel[type] || type}</div>`;
      html += `<div class="admin-list">${items.map(itemCard).join('')}</div>`;
    }
    if (!products.length) html += TaroUI.empty('Товаров нет', 'Добавь первый товар');
    return html;
  },

  _adminProductForm(s) {
    const p = s.adminEditing || {};
    const isEdit = !!p.id;
    return `
      <div class="admin-form-wrap">
        <div class="admin-form-back" onclick="App.adminEdit(null)">‹ Назад</div>
        <h3 class="admin-form-title">${isEdit ? 'Редактировать товар' : 'Новый товар'}</h3>
        <div class="admin-form-field">
          <label class="admin-label">Название</label>
          <input class="tui-input" id="prod_name" type="text" value="${TaroUI.esc(p.name_ru || '')}" placeholder="Название товара">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Slug (URL)</label>
          <input class="tui-input" id="prod_slug" type="text" value="${TaroUI.esc(p.slug || '')}" placeholder="auto">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Описание</label>
          <textarea class="tui-input" id="prod_desc" rows="3" placeholder="Описание товара">${TaroUI.esc(p.description || '')}</textarea>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Цена (центы, $1 = 100)</label>
          <input class="tui-input" id="prod_price" type="number" value="${p.price_usd_cents || 0}" min="0">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Тип</label>
          <select class="tui-input" id="prod_type">
            <option value="goods" ${p.product_type === 'goods' ? 'selected' : ''}>Товар</option>
            <option value="deck" ${p.product_type === 'deck' ? 'selected' : ''}>Колода</option>
            <option value="service" ${p.product_type === 'service' ? 'selected' : ''}>Услуга</option>
          </select>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Активен</label>
          <select class="tui-input" id="prod_active">
            <option value="true" ${p.is_active !== false ? 'selected' : ''}>Да (виден в магазине)</option>
            <option value="false" ${p.is_active === false ? 'selected' : ''}>Нет (скрыт)</option>
          </select>
        </div>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow"
          onclick="App.adminSaveProduct({
            id: ${p.id ? `'${p.id}'` : 'null'},
            name: document.getElementById('prod_name').value,
            slug: document.getElementById('prod_slug').value,
            description: document.getElementById('prod_desc').value,
            price_usd_cents: parseInt(document.getElementById('prod_price').value),
            product_type: document.getElementById('prod_type').value,
            is_active: document.getElementById('prod_active').value === 'true'
          })">
          Сохранить ✦
        </button>
      </div>`;
  },

  // ═══ ADMIN: РАССЫЛКИ ═══
  _adminBroadcasts(s) {
    if (s.adminEditing && s.adminEditing._type === 'broadcast') {
      return Screens._adminBroadcastForm(s);
    }
    const items = (s.adminBroadcasts || []).map(b => {
      const statusBadge = (st) => {
        const cls = st === 'sent' ? 'admin-badge-green' : st === 'sending' ? 'admin-badge-gold' : st === 'scheduled' ? 'admin-badge-gold' : 'admin-badge-dim';
        return `<span class="admin-badge ${cls}">${st}</span>`;
      };
      const stats = `Отправлено: ${b.sent_count || 0} · Открыто: ${b.opened_count || 0} · Конверсия: ${b.converted_count || 0}`;
      const rule = b.segment_rule ? JSON.stringify(b.segment_rule) : '{}';
      return `<div class="admin-item">
        <div class="admin-item-row" onclick="this.classList.toggle('open')">
          <div class="admin-item-emoji">✧</div>
          <div class="admin-item-main">
            <div class="admin-item-title">${TaroUI.esc(b.title)}</div>
            <div class="admin-item-meta">${statusBadge(b.status)} · ${stats}</div>
          </div>
          <div class="admin-item-chevron">›</div>
        </div>
        <div class="admin-item-detail">
          <p class="admin-broadcast-body">${TaroUI.esc(b.body)}</p>
          <div class="admin-item-actions">
            ${(b.status === 'draft' || b.status === 'scheduled') ? `<button class="tui-btn tui-btn-primary tui-btn-small" onclick="App.adminSendBroadcast('${b.id}')">Отправить сейчас</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="admin-section-header">
        <span>Рассылки</span>
        <button class="tui-btn tui-btn-primary tui-btn-small" onclick="App.adminEdit({_type:'broadcast', status:'draft', segment_rule:{}})">+ Новая рассылка</button>
      </div>
      ${items ? `<div class="admin-list">${items}</div>` : TaroUI.empty('Рассылок нет', 'Создай первую рассылку')}`;
  },

  _adminBroadcastForm(s) {
    const b = s.adminEditing || {};
    return `
      <div class="admin-form-wrap">
        <div class="admin-form-back" onclick="App.adminEdit(null)">‹ Назад</div>
        <h3 class="admin-form-title">Новая рассылка</h3>
        <div class="admin-form-field">
          <label class="admin-label">Заголовок</label>
          <input class="tui-input" id="bc_title" type="text" placeholder="Заголовок рассылки">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Текст</label>
          <textarea class="tui-input admin-textarea-md" id="bc_body" rows="6" placeholder="Текст рассылки..."></textarea>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Фильтр по тарифу</label>
          <select class="tui-input" id="bc_tier">
            <option value="">Все</option>
            <option value="free">Free</option>
            <option value="basic">Basic</option>
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
          </select>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Фильтр по сфере</label>
          <select class="tui-input" id="bc_sphere">
            <option value="">Все сферы</option>
            <option value="love">Любовь</option>
            <option value="finance">Финансы</option>
            <option value="health">Здоровье</option>
            <option value="family">Семья</option>
            <option value="purpose">Предназначение</option>
          </select>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Статус</label>
          <select class="tui-input" id="bc_status">
            <option value="draft">Черновик</option>
            <option value="scheduled">Запланирована</option>
          </select>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Дата/время (для scheduled)</label>
          <input class="tui-input" id="bc_scheduled" type="datetime-local">
        </div>
        <button class="tui-btn tui-btn-primary tui-btn-full tui-btn-glow"
          onclick="App.adminSaveBroadcast({
            title: document.getElementById('bc_title').value,
            body: document.getElementById('bc_body').value,
            segment_rule: {
              tier: document.getElementById('bc_tier').value ? [document.getElementById('bc_tier').value] : null,
              spheres: document.getElementById('bc_sphere').value ? [document.getElementById('bc_sphere').value] : null
            },
            status: document.getElementById('bc_status').value,
            scheduled_at: document.getElementById('bc_scheduled').value || null
          })">
          Создать рассылку ✦
        </button>
      </div>`;
  },

  // ═══ ADMIN: НАСТРОЙКИ ═══
  _adminSettings(s) {
    return `
      <div class="admin-profile-wrap">
        <div class="admin-profile-icon">✦</div>
        <h3 class="admin-form-title">Профиль владельца</h3>
        <div class="tui-hint" style="margin-bottom:16px;text-align:center">
          Для смены логина/пароля обнови секреты Edge Function:
          <code class="admin-code">supabase secrets set ADMIN_LOGIN=новый_логин ADMIN_PASSWORD=новый_пароль</code>
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Новый логин</label>
          <input class="tui-input" id="adm_new_login" type="text" placeholder="Новый логин">
        </div>
        <div class="admin-form-field">
          <label class="admin-label">Новый пароль</label>
          <input class="tui-input" id="adm_new_pass" type="password" placeholder="Новый пароль">
        </div>
        <button class="tui-btn tui-btn-secondary tui-btn-full"
          onclick="App.adminChangeCredentials()">
          Запросить смену ✦
        </button>
        <div class="tui-hint" style="margin-top:12px;text-align:center">
          После смены секретов перезагрузи Edge Function.
        </div>
      </div>`;
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
  { id: 'home', icon: '✦', label: 'Карта' },
  { id: 'history', icon: '☽', label: 'История' },
  { id: 'shop', icon: '❖', label: 'Магазин' },
  { id: 'profile', icon: '☉', label: 'Профиль' },
];

document.addEventListener('DOMContentLoaded', () => App.init());
