(function () {
  'use strict';

  const FIELDS = [
    ['name', '姓名'], ['nameEn', '英文姓名'], ['company', '公司'], ['department', '部門'],
    ['title', '職稱'], ['mobile', '手機'], ['phone', '電話'], ['fax', '傳真'],
    ['email', 'Email'], ['website', '網址'], ['address', '地址'], ['note', '備註'],
  ];
  const PHONE_FIELDS = new Set(['mobile', 'phone', 'fax']);

  const $ = (id) => document.getElementById(id);
  const els = {
    list: $('list'), empty: $('empty'), noresult: $('noresult'), search: $('search'), stats: $('stats'),
    views: { list: $('view-list'), detail: $('view-detail'), edit: $('view-edit'), settings: $('view-settings') },
    listNav: $('list-nav'), form: $('form'),
    preview: $('preview'), previewWrap: $('preview-wrap'),
    ocrStatus: $('ocr-status'), ocrRing: $('ocr-ring'), ocrMsg: $('ocr-msg'), ocrBadge: $('ocr-badge'),
    raw: $('raw'), rawWrap: $('raw-wrap'), editTitle: $('edit-title'),
    toast: $('toast'), save: $('btn-save'), rotate: $('btn-rotate'),
  };

  // ---------- IndexedDB ----------
  const DB_NAME = 'card-scanner';
  const STORE = 'cards';
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      const r = fn(store);
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const getAll = () => tx('readonly', (s) => s.getAll());
  const putCard = (c) => tx('readwrite', (s) => s.put(c));
  const deleteCard = (id) => tx('readwrite', (s) => s.delete(id));
  const putMany = (list) => tx('readwrite', (s) => { list.forEach((c) => s.put(c)); });

  // 加到主畫面後，要求瀏覽器不要自動清掉資料
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // ---------- 設定（只存在這支手機） ----------
  const SETTINGS_KEY = 'card-scanner-settings';
  let settings = { mode: 'local', provider: 'deepseek', apiKey: '', model: CardAI.DEFAULT_MODEL, dsKey: '', orKey: '', orModel: CardAI.OPENROUTER_DEFAULT_MODEL, enhance: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* 無痕模式等 */ }
  if (!/^(deepseek|qwen)\//.test(settings.orModel || '')) settings.orModel = CardAI.OPENROUTER_DEFAULT_MODEL; // OpenRouter 只用 DeepSeek / Qwen
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
    renderFootnote();
  }
  const aiKey = () => ({ claude: settings.apiKey, openrouter: settings.orKey }[settings.provider] ?? settings.dsKey);
  const aiModel = () => ({ claude: settings.model, openrouter: settings.orModel || CardAI.OPENROUTER_DEFAULT_MODEL }[settings.provider] ?? CardAI.DEEPSEEK_DEFAULT_MODEL);
  function readKeyInputs() {
    settings.apiKey = $('set-key').value.trim();
    settings.dsKey = $('set-ds-key').value.trim();
    settings.orKey = $('set-or-key').value.trim();
    settings.orModel = $('set-or-model').value || settings.orModel || CardAI.OPENROUTER_DEFAULT_MODEL;
  }
  let orModelsLoaded = false;
  function fillOrModels(list) {
    const sel = $('set-or-model');
    const cur = settings.orModel || CardAI.OPENROUTER_DEFAULT_MODEL;
    const items = list.slice();
    if (!items.some((m) => m.id === cur)) items.unshift({ id: cur, name: cur });
    // DeepSeek 一組、Qwen 一組
    sel.replaceChildren();
    [['DeepSeek', 'deepseek/'], ['Qwen', 'qwen/'], ['其他', '']].forEach(([label, prefix]) => {
      const opts = items.filter((m) => (prefix ? m.id.startsWith(prefix) : !/^(deepseek|qwen)\//.test(m.id)));
      if (!opts.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      opts.forEach((m) => g.append(new Option(m.id.replace(/^[^/]+\//, ''), m.id)));
      sel.append(g);
    });
    sel.value = cur;
  }
  async function loadOrModels() {
    if (!orModelsLoaded) fillOrModels((CardAI.OPENROUTER_SUGGEST || []).map((id) => ({ id })));
    if (orModelsLoaded) return;
    orModelsLoaded = true;
    try {
      const list = await CardAI.listOpenrouterVisionModels();
      if (list.length) fillOrModels(list);
    } catch (e) { orModelsLoaded = false; }
  }
  const useAI = () => settings.mode === 'ai' && !!aiKey();
  const providerLabel = () => (CardAI.PROVIDERS[settings.provider] || CardAI.PROVIDERS.deepseek).label;

  function renderFootnote() {
    const f = $('list-foot');
    f.replaceChildren();
    if (useAI()) {
      f.append(svg('i-spark'), `AI 辨識已開啟：拍照時照片會傳給 ${providerLabel()} 辨識。`, document.createElement('br'), '名片資料仍只存在這支手機，換手機前請先匯出 CSV。');
    } else {
      f.append(svg('i-lock'), '照片與資料只存在這支手機，不會上傳。', document.createElement('br'), '換手機或清除資料前，請先匯出 CSV 備份。');
    }
  }

  function openSettings() {
    document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === settings.mode; });
    $('set-key').value = settings.apiKey;
    const sel = $('set-model');
    if (!sel.options.length) {
      CardAI.MODELS.forEach((m) => sel.append(new Option(m.label, m.id)));
    }
    sel.value = settings.model;
    $('set-ds-key').value = settings.dsKey;
    $('set-or-key').value = settings.orKey || '';
    $('set-provider').value = settings.provider;
    $('set-enhance').checked = settings.enhance !== false;
    syncSettingsUI();
    show('settings');
  }
  function syncSettingsUI() {
    $('test-result').hidden = true;
    $('ai-settings').hidden = settings.mode !== 'ai';
    $('ds-settings').hidden = settings.provider !== 'deepseek';
    $('cl-settings').hidden = settings.provider !== 'claude';
    $('or-settings').hidden = settings.provider !== 'openrouter';
    if (settings.provider === 'openrouter') loadOrModels();
  }
  $('set-enhance').addEventListener('change', (e) => { settings.enhance = e.target.checked; saveSettings(); });
  $('set-provider').addEventListener('change', (e) => { settings.provider = e.target.value; syncSettingsUI(); saveSettings(); });
  $('set-ds-key').addEventListener('change', (e) => { settings.dsKey = e.target.value.trim(); saveSettings(); });
  $('set-or-key').addEventListener('change', () => { readKeyInputs(); saveSettings(); });
  $('set-or-model').addEventListener('change', () => { readKeyInputs(); saveSettings(); });

  async function onTestAI() {
    readKeyInputs();
    saveSettings();
    const box = $('test-result');
    const btn = $('btn-test-ai');
    if (!aiKey()) { toast('請先填 API Key'); return; }
    const model = aiModel();
    box.hidden = false;
    box.className = 'row test-result run';
    box.replaceChildren(el('div', 'head', `測試中：${providerLabel()} / ${model}…`));
    btn.disabled = true;
    try {
      const r = await CardAI.testProvider(settings.provider, { apiKey: aiKey(), model });
      const allOk = r.passed === r.checks.length;
      box.className = 'row test-result ' + (allOk ? 'ok' : 'err');
      const head = allOk
        ? `✓ 成功：讀對 ${r.passed}/${r.checks.length} 個欄位，耗時 ${(r.ms / 1000).toFixed(1)} 秒`
        : `△ 連線成功，但只讀對 ${r.passed}/${r.checks.length} 個欄位（這個模型可能不支援圖片）`;
      const img = document.createElement('img');
      img.src = r.image;
      img.alt = '測試名片';
      const dl = document.createElement('dl');
      [['模型', r.model], ['姓名', r.fields.name], ['公司', r.fields.company], ['職稱', r.fields.title], ['手機', r.fields.mobile], ['Email', r.fields.email]].forEach(([k, v]) => {
        dl.append(el('dt', '', k), el('dd', '', v || '（空白）'));
      });
      box.replaceChildren(el('div', 'head', head), img, dl);
    } catch (e) {
      box.className = 'row test-result err';
      box.replaceChildren(el('div', 'head', '✕ 失敗：' + e.message));
    } finally {
      btn.disabled = false;
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  $('btn-test-ai').addEventListener('click', onTestAI);
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
    settings.mode = r.value;
    syncSettingsUI();
    saveSettings();
  }));
  $('set-key').addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); });
  $('set-model').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(); });
  function leaveSettings() {
    readKeyInputs();
    saveSettings();
    if (settings.mode === 'ai' && !aiKey()) toast('尚未填 API Key，會先用本機辨識');
    show('list');
  }

  // ---------- 狀態 ----------
  let cards = [];
  let current = null; // 詳情頁顯示中的名片
  let editing = null; // 編輯中的紀錄
  let editingIsNew = false;
  let currentImage = null; // { img, rotation, autoFilled }
  let ocrRun = 0;

  function toast(msg, ms = 2200) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    els.toast.style.animation = 'none';
    void els.toast.offsetWidth;
    els.toast.style.animation = '';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  function haptic() {
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function show(view) {
    Object.entries(els.views).forEach(([k, v]) => { v.hidden = k !== view; });
    window.scrollTo(0, 0);
    onScroll();
  }

  // ---------- 頭像 ----------
  const AVATAR_COLORS = [
    ['#5b8def', '#2f5fc4'], ['#2bb3a3', '#14857a'], ['#f08a5d', '#cf5d32'], ['#9b7ae8', '#6b4bc4'],
    ['#e86a92', '#c2406a'], ['#4fb26b', '#2c8746'], ['#e0a83c', '#b9801a'], ['#6b8299', '#465b70'],
  ];
  function initials(c) {
    const n = (c.name || '').trim();
    if (n) return n.length >= 3 ? n.slice(-2) : n.slice(-2);
    const en = (c.nameEn || '').trim();
    if (en) return en.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const co = (c.company || '').trim();
    return co ? co[0].toUpperCase() : '?';
  }
  function paintAvatar(el, c) {
    const key = c.name || c.nameEn || c.company || c.id || '';
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const [a1, a2] = AVATAR_COLORS[h % AVATAR_COLORS.length];
    el.style.setProperty('--a1', a1);
    el.style.setProperty('--a2', a2);
    el.textContent = initials(c);
    el.style.fontSize = /^[A-Z?]+$/.test(el.textContent) ? '' : (el.classList.contains('xl') ? '32px' : '16px');
  }

  // ---------- 列表 ----------
  async function refresh() {
    cards = (await getAll()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    renderList();
  }

  function renderList() {
    const q = els.search.value.trim().toLowerCase();
    const shown = q
      ? cards.filter((c) => FIELDS.some(([k]) => (c[k] || '').toLowerCase().includes(q)))
      : cards;

    els.empty.hidden = cards.length > 0;
    els.stats.hidden = cards.length === 0 || !!q;
    els.noresult.hidden = !(q && cards.length && !shown.length);
    if (cards.length) {
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      $('stat-total').textContent = cards.length;
      $('stat-company').textContent = new Set(cards.map((c) => (c.company || '').trim()).filter(Boolean)).size;
      $('stat-month').textContent = cards.filter((c) => (c.createdAt || '').startsWith(ym)).length;
    }

    els.list.replaceChildren();
    if (!shown.length) return;

    // 依新增時間分組
    const groups = new Map();
    shown.forEach((c) => {
      const label = q ? `搜尋結果 ${shown.length} 筆` : groupLabel(c.createdAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(c);
    });
    groups.forEach((items, label) => {
      const h = document.createElement('h3');
      h.className = 'group-title';
      h.textContent = label;
      const g = document.createElement('div');
      g.className = 'group';
      items.forEach((c) => g.append(renderRow(c, q)));
      els.list.append(h, g);
    });
  }

  function groupLabel(iso) {
    if (!iso) return '更早';
    const d = new Date(iso);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return '本週';
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return '本月';
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
  }

  function highlight(el, text, q) {
    if (!q) { el.textContent = text; return; }
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) { el.textContent = text; return; }
    const m = document.createElement('mark');
    m.textContent = text.slice(i, i + q.length);
    el.append(text.slice(0, i), m, text.slice(i + q.length));
  }

  function renderRow(c, q) {
    const row = document.createElement('div');
    row.className = 'row card-row';
    const av = document.createElement('div');
    av.className = 'avatar';
    paintAvatar(av, c);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'n';
    highlight(n, c.name || c.nameEn || c.company || '（未命名）', q);
    if (c.title) { const s = document.createElement('small'); s.textContent = c.title; n.append(s); }
    const s = document.createElement('div');
    s.className = 's';
    const sub = c.name || c.nameEn ? c.company : (c.department || '');
    const extra = q && !(sub || '').toLowerCase().includes(q)
      ? FIELDS.map(([k]) => c[k] || '').find((v) => v.toLowerCase().includes(q))
      : '';
    highlight(s, extra || sub || c.mobile || c.phone || c.email || '', q);
    meta.append(n, s);
    const chev = svg('i-chev', 'chev');
    row.append(av, meta, chev);
    row.addEventListener('click', () => openDetail(c));
    return row;
  }

  function svg(id, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    if (cls) s.setAttribute('class', cls);
    const u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  }

  // 大標題捲動後收合成小標題
  function onScroll() {
    els.listNav.classList.toggle('scrolled', window.scrollY > 40);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---------- 詳情 ----------
  function telHref(v) {
    const first = (v || '').split(' / ')[0].split(' #')[0];
    const d = first.replace(/[^\d+]/g, '');
    return d ? 'tel:' + d : '';
  }
  function webHref(v) {
    if (!v) return '';
    return /^https?:\/\//i.test(v) ? v : 'https://' + v;
  }
  function mapHref(v) {
    return v ? 'https://maps.apple.com/?q=' + encodeURIComponent(v) : '';
  }

  function setQuick(id, href) {
    const a = $(id);
    if (href) { a.href = href; a.classList.remove('disabled'); }
    else { a.removeAttribute('href'); a.classList.add('disabled'); }
  }

  function openDetail(c) {
    current = c;
    paintAvatar($('d-avatar'), c);
    $('d-name').textContent = c.name || c.nameEn || c.company || '（未命名）';
    $('d-name-en').textContent = c.name ? c.nameEn || '' : '';
    $('d-role').textContent = [c.department, c.title].filter(Boolean).join(' · ');
    $('d-company').textContent = c.name || c.nameEn ? c.company || '' : '';

    const callNum = c.mobile || c.phone;
    setQuick('q-call', telHref(callNum));
    setQuick('q-sms', c.mobile ? 'sms:' + telHref(c.mobile).slice(4) : '');
    setQuick('q-mail', c.email ? 'mailto:' + c.email : '');
    setQuick('q-map', mapHref(c.address));

    const info = $('d-info');
    info.className = 'group info';
    info.replaceChildren();
    const rows = [
      ['手機', c.mobile, telHref(c.mobile)],
      ['電話', c.phone, telHref(c.phone)],
      ['傳真', c.fax, ''],
      ['Email', c.email, c.email ? 'mailto:' + c.email : ''],
      ['網址', c.website, webHref(c.website)],
      ['地址', c.address, mapHref(c.address)],
      ['備註', c.note, ''],
    ];
    rows.forEach(([k, v, href]) => {
      if (!v) return;
      const r = document.createElement(href ? 'a' : 'div');
      r.className = 'row';
      if (href) {
        r.href = href;
        if (/^https:/.test(href)) { r.target = '_blank'; r.rel = 'noopener'; }
      }
      const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'v'; vv.textContent = v;
      r.append(kk, vv);
      info.append(r);
    });
    info.hidden = !info.children.length;

    $('d-photo-wrap').hidden = !c.thumb;
    if (c.thumb) $('d-photo').src = c.thumb;
    $('d-meta').textContent = c.createdAt ? `新增於 ${formatDate(c.createdAt)}` : '';
    show('detail');
  }

  async function onDelete() {
    if (!current) return;
    if (!confirm(`確定刪除「${current.name || current.company || '這張名片'}」？此動作無法復原。`)) return;
    await deleteCard(current.id);
    current = null;
    toast('已刪除');
    await refresh();
    show('list');
  }

  // ---------- vCard（加入通訊錄） ----------
  function vEsc(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }
  function buildVcard(c) {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    const name = c.name || '';
    let family = '', given = '';
    if (name && /[\u3400-\u9fff]/.test(name)) {
      const compound = ['歐陽', '司馬', '諸葛', '上官', '張簡', '范姜'].find((x) => name.startsWith(x) && name.length > 2);
      family = compound || name[0];
      given = name.slice(family.length);
    } else if (c.nameEn) {
      const parts = c.nameEn.trim().split(/\s+/);
      family = parts.length > 1 ? parts.pop() : '';
      given = parts.join(' ');
    }
    lines.push(`N:${vEsc(family)};${vEsc(given)};;;`);
    lines.push(`FN:${vEsc(name || c.nameEn || c.company || '')}`);
    if (c.company || c.department) lines.push(`ORG:${vEsc(c.company)}${c.department ? ';' + vEsc(c.department) : ''}`);
    if (c.title) lines.push(`TITLE:${vEsc(c.title)}`);
    const tels = (v) => (v || '').split(' / ').map((x) => x.trim()).filter(Boolean);
    tels(c.mobile).forEach((t) => lines.push(`TEL;TYPE=CELL:${t.replace(' #', ',')}`));
    tels(c.phone).forEach((t) => lines.push(`TEL;TYPE=WORK,VOICE:${t.replace(' #', ',')}`));
    tels(c.fax).forEach((t) => lines.push(`TEL;TYPE=WORK,FAX:${t}`));
    if (c.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${c.email}`);
    if (c.website) lines.push(`URL:${webHref(c.website)}`);
    if (c.address) lines.push(`ADR;TYPE=WORK:;;${vEsc(c.address)};;;;`);
    const note = [c.nameEn && name ? c.nameEn : '', c.note].filter(Boolean).join('\n');
    if (note) lines.push(`NOTE:${vEsc(note)}`);
    if (c.thumb && c.thumb.startsWith('data:image/jpeg;base64,')) {
      // 通訊錄大頭照用名片照片
      lines.push(`PHOTO;ENCODING=b;TYPE=JPEG:${c.thumb.slice(23)}`);
    }
    lines.push('END:VCARD');
    return lines.join('\r\n') + '\r\n';
  }

  async function shareFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const file = new File([blob], filename, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  async function onVcard() {
    if (!current) return;
    const fname = (current.name || current.nameEn || current.company || 'contact').replace(/[\\/:*?"<>|]/g, '') + '.vcf';
    await shareFile(buildVcard(current), fname, 'text/vcard');
  }

  // ---------- 編輯 ----------
  function fillForm(data) {
    FIELDS.forEach(([k]) => {
      els.form.elements[k].value = data[k] || '';
      els.form.elements[k].closest('.row').classList.remove('autofill');
    });
  }

  function readForm() {
    const out = {};
    FIELDS.forEach(([k]) => { out[k] = els.form.elements[k].value.trim(); });
    return out;
  }

  function openEdit(card) {
    editingIsNew = !card;
    editing = card ? { ...card } : { id: newId(), createdAt: new Date().toISOString() };
    currentImage = null;
    ocrRun++;
    fillForm(editing);
    els.editTitle.textContent = card ? '編輯名片' : '新名片';
    els.previewWrap.hidden = true;
    els.previewWrap.classList.remove('scanning');
    els.raw.textContent = editing.rawText || '';
    els.rawWrap.hidden = !editing.rawText;
    show('edit');
  }

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  }

  async function onSave() {
    const data = readForm();
    if (!Object.values(data).some(Boolean)) { toast('請至少填寫一個欄位'); return; }
    const rec = { ...editing, ...data, updatedAt: new Date().toISOString() };
    ocrRun++;
    await putCard(rec);
    haptic();
    await refresh();
    toast(editingIsNew ? '已加入名片夾' : '已更新');
    openDetail(rec);
  }

  function onCancel() {
    ocrRun++;
    if (!editingIsNew && current) openDetail(current);
    else show('list');
  }

  // ---------- 影像處理 ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
      img.src = url;
    });
  }

  function drawScaled(src, maxSide, rotation = 0) {
    const w0 = src.naturalWidth || src.width;
    const h0 = src.naturalHeight || src.height;
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const swap = rotation % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = swap ? h : w;
    c.height = swap ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    return c;
  }

  // 灰階 + 拉對比，提高辨識率
  function toOcrCanvas(src) {
    const c = drawScaled(src, 2000);
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let min = 255, max = 0;
    const gray = new Uint8ClampedArray(d.length / 4);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[j] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = ((gray[j] - min) * 255) / range;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- OCR ----------
  let workerPromise = null;
  let progressCb = null;
  function getWorker() {
    if (!workerPromise) {
      const base = new URL('./', location.href).href;
      workerPromise = Tesseract.createWorker(['chi_tra', 'eng'], 1, {
        workerPath: base + 'vendor/worker.min.js',
        corePath: base + 'vendor/core',
        langPath: base + 'vendor/lang',
        gzip: true,
        cacheMethod: 'none', // 由 service worker 快取，避免重複佔用空間
        logger: (m) => progressCb && progressCb(m),
      }).catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  const STATUS_TEXT = {
    'loading tesseract core': '載入辨識引擎',
    'initializing tesseract': '初始化',
    'loading language traineddata': '載入中英文字庫（首次較久）',
    'initializing api': '初始化',
    'recognizing text': '辨識文字中',
  };

  function setStatus(text, progress, state, opts = {}) {
    els.ocrMsg.textContent = text;
    els.ocrBadge.hidden = !opts.ai;
    els.ocrStatus.querySelector('.ring').classList.toggle('spin', !!opts.spin);
    els.ocrRing.style.strokeDashoffset = String(94.25 * (1 - Math.max(0, Math.min(1, progress))));
    els.ocrStatus.className = 'scan-status' + (state ? ' ' + state : '');
  }

  const ocrSource = () => currentImage.img;

  function applyParsed(parsed) {
    // 使用者自己填的欄位不覆蓋
    const cur = readForm();
    let filled = 0;
    FIELDS.forEach(([k]) => {
      if (cur[k] && !currentImage.autoFilled.has(k)) return;
      const input = els.form.elements[k];
      input.value = parsed[k] || '';
      input.closest('.row').classList.toggle('autofill', !!parsed[k]);
      if (parsed[k]) { currentImage.autoFilled.add(k); filled++; }
      else currentImage.autoFilled.delete(k);
    });
    return filled;
  }

  async function runAiOcr(run) {
    els.previewWrap.classList.add('ai');
    setStatus(`${providerLabel()} 辨識中…`, 0.25, '', { ai: true, spin: true });
    const jpeg = drawScaled(ocrSource(), 1568, currentImage.rotation).toDataURL('image/jpeg', 0.85);
    const provider = CardAI.PROVIDERS[settings.provider] || CardAI.PROVIDERS.deepseek;
    const { fields } = await provider.extract({
      apiKey: aiKey(),
      model: aiModel(),
      imageBase64: jpeg.slice(jpeg.indexOf(',') + 1),
    });
    if (run !== ocrRun) return;
    editing.rawText = '';
    els.rawWrap.hidden = true;
    const filled = applyParsed(fields);
    editing.ocrBy = 'ai';
    if (filled) setStatus(`AI 已辨識 ${filled} 個欄位`, 1, 'done', { ai: true });
    else setStatus('AI 沒有讀到資料，可旋轉重掃或手動輸入', 1, 'error', { ai: true });
  }

  async function runLocalOcr(run, prefix = '') {
    els.previewWrap.classList.remove('ai');
    setStatus(prefix + '準備中…', 0.03);
    progressCb = (m) => {
      if (run !== ocrRun) return;
      setStatus(prefix + (STATUS_TEXT[m.status] || m.status) + '…', Math.max(0.03, m.progress || 0));
    };
    const rotated = drawScaled(ocrSource(), 2400, currentImage.rotation);
    const worker = await getWorker();
    const { data } = await worker.recognize(toOcrCanvas(rotated));
    if (run !== ocrRun) return;
    const text = (data.text || '').trim();
    const filled = applyParsed(CardParser.parseCard(text));
    els.raw.textContent = text;
    els.rawWrap.hidden = !text;
    editing.rawText = text;
    editing.ocrBy = 'local';
    if (filled) setStatus(`已辨識 ${filled} 個欄位`, 1, 'done');
    else setStatus(text ? '沒抓到欄位，請看辨識原文或旋轉重掃' : '沒辨識到文字，可旋轉重掃或手動輸入', 1, 'error');
  }

  async function runOcr() {
    if (!currentImage) return;
    const run = ++ocrRun;
    els.previewWrap.classList.add('scanning');
    els.rotate.disabled = true;
    try {
      if (useAI()) {
        try {
          await runAiOcr(run);
        } catch (e) {
          console.error(e);
          if (run !== ocrRun) return;
          // AI 失敗（沒網路、Key 錯誤等）時退回本機辨識
          toast(e.message + '，改用本機辨識', 3500);
          await runLocalOcr(run, '改用本機：');
        }
      } else {
        await runLocalOcr(run);
      }
      if (run === ocrRun) haptic();
    } catch (e) {
      console.error(e);
      if (run !== ocrRun) return;
      setStatus('辨識失敗，請手動輸入', 1, 'error');
    } finally {
      if (run === ocrRun) {
        els.rotate.disabled = false;
        els.previewWrap.classList.remove('scanning');
      }
    }
  }

  function showCurrentImage() {
    editing.thumb = drawScaled(currentImage.img, 1000, currentImage.rotation).toDataURL('image/jpeg', 0.8);
    els.preview.src = editing.thumb;
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      processImage(await loadImage(file));
    } catch (err) {
      toast(err.message || '無法讀取圖片');
    }
  }

  function imgSize(src) {
    return [src.naturalWidth || src.width, src.naturalHeight || src.height];
  }

  function defaultCorners(src) {
    const [w, h] = imgSize(src);
    const mx = w * 0.06, my = h * 0.06;
    return [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
  }

  function initialCorners(src) {
    if (settings.enhance !== false) {
      try {
        const c = CardEnhance.detectCard(src);
        if (c) return c;
      } catch (e) { console.error(e); }
    }
    return defaultCorners(src);
  }

  function applyCrop(orig, corners) {
    return corners ? CardEnhance.warp(orig, corners) : drawScaled(orig, 2000);
  }

  // 照片（Image 或 Canvas）→ 使用者確認裁切 → 辨識
  async function processImage(orig) {
    const corners = await openCropper(orig, initialCorners(orig));
    openEdit(null);
    try {
      currentImage = { orig, corners, img: applyCrop(orig, corners), rotation: 0, autoFilled: new Set() };
      $('btn-crop').hidden = false;
      showCurrentImage();
      els.previewWrap.hidden = false;
      runOcr();
    } catch (err) {
      toast(err.message || '無法讀取圖片');
    }
  }

  function onRotate() {
    if (!currentImage) return;
    currentImage.rotation = (currentImage.rotation + 90) % 360;
    showCurrentImage();
    runOcr();
  }

  // 編輯畫面再次調整裁切
  async function onRecrop() {
    if (!currentImage) return;
    const ci = currentImage;
    const corners = await openCropper(ci.orig, ci.corners || defaultCorners(ci.orig));
    if (currentImage !== ci) return;
    ci.corners = corners;
    ci.img = applyCrop(ci.orig, corners);
    showCurrentImage();
    runOcr();
  }
  $('btn-crop').addEventListener('click', onRecrop);

  // ---------- 手動裁切畫面：拖動四個角 ----------
  // 回傳原圖座標的四個角；按「不裁切」回傳 null
  function openCropper(src, startCorners) {
    return new Promise((resolve) => {
      const box = $('cropper');
      const stage = $('crop-stage');
      const canvas = $('crop-canvas');
      const svg = $('crop-svg');
      const handles = $('crop-handles');
      box.hidden = false;
      const [w, h] = imgSize(src);
      const sr = stage.getBoundingClientRect();
      const scale = Math.min((sr.width - 32) / w, (sr.height - 32) / h);
      const dw = Math.round(w * scale), dh = Math.round(h * scale);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(dw * dpr); canvas.height = Math.round(dh * dpr);
      canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
      canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
      svg.setAttribute('viewBox', `0 0 ${dw} ${dh}`);

      // 以畫面座標操作
      let pts = startCorners.map(([x, y]) => [x * scale, y * scale]);
      const ns = 'http://www.w3.org/2000/svg';
      handles.replaceChildren();
      const circles = pts.map(() => {
        const g = document.createElementNS(ns, 'g');
        const ring = document.createElementNS(ns, 'circle');
        ring.setAttribute('r', '13'); ring.setAttribute('class', 'ring');
        const hit = document.createElementNS(ns, 'circle');
        hit.setAttribute('r', '30'); hit.setAttribute('class', 'hit');
        g.append(ring, hit);
        handles.append(g);
        return g;
      });
      function draw() {
        const poly = pts.map((p) => p.join(',')).join(' ');
        $('crop-poly').setAttribute('points', poly);
        $('crop-mask').setAttribute('d', `M0 0H${dw}V${dh}H0Z M${pts.map((p) => p.join(' ')).join(' L')} Z`);
        circles.forEach((g, i) => g.setAttribute('transform', `translate(${pts[i][0]} ${pts[i][1]})`));
      }
      draw();

      let active = -1;
      const toLocal = (e) => {
        const r = svg.getBoundingClientRect();
        return [Math.min(dw, Math.max(0, e.clientX - r.left)), Math.min(dh, Math.max(0, e.clientY - r.top))];
      };
      function down(e) {
        const [x, y] = toLocal(e);
        let best = -1, bd = 48;
        pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
        if (best < 0) return;
        active = best;
        svg.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      function move(e) {
        if (active < 0) return;
        pts[active] = toLocal(e);
        draw();
        e.preventDefault();
      }
      function up() { active = -1; }
      svg.addEventListener('pointerdown', down);
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
      svg.addEventListener('pointercancel', up);

      function finish(result) {
        svg.removeEventListener('pointerdown', down);
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
        svg.removeEventListener('pointercancel', up);
        $('crop-done').onclick = $('crop-skip').onclick = $('crop-reset').onclick = null;
        box.hidden = true;
        resolve(result);
      }
      $('crop-done').onclick = () => finish(pts.map(([x, y]) => [x / scale, y / scale]));
      $('crop-skip').onclick = () => finish(null);
      $('crop-reset').onclick = () => { pts = initialCorners(src).map(([x, y]) => [x * scale, y * scale]); draw(); };
    });
  }

  // ---------- App 內建相機：按下快門當下就鎖定畫面 ----------
  const cam = { stream: null, track: null, torch: false };

  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('file-camera').click(); // 不支援就用系統相機
      return;
    }
    const box = $('camera');
    const video = $('cam-video');
    box.hidden = false;
    setCamFrozen(false);
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      cam.track = cam.stream.getVideoTracks()[0];
      video.srcObject = cam.stream;
      await video.play().catch(() => {});
      // 有閃光燈（手電筒）才顯示按鈕
      const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
      $('cam-torch').hidden = !caps.torch;
      $('cam-spacer').hidden = !!caps.torch;
    } catch (err) {
      console.error(err);
      closeCamera();
      toast('無法開啟相機，改用系統相機', 2600);
      $('file-camera').click();
    }
  }

  function closeCamera() {
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null; cam.track = null; cam.torch = false;
    $('cam-video').srcObject = null;
    $('camera').hidden = true;
  }

  function setCamFrozen(frozen) {
    $('camera').classList.toggle('frozen', frozen);
    $('cam-still').hidden = !frozen;
    $('cam-video').hidden = frozen;
    $('cam-review').hidden = !frozen;
    document.querySelector('#camera .cam-bar:not(.review)').hidden = frozen;
  }

  function onShutter() {
    const video = $('cam-video');
    if (!video.videoWidth) return;
    // 立刻抓這一幀，之後怎麼移動手機都不影響
    const still = $('cam-still');
    still.width = video.videoWidth;
    still.height = video.videoHeight;
    still.getContext('2d').drawImage(video, 0, 0);
    cam.crop = guideRectInVideo(video);
    const f = document.createElement('div');
    f.className = 'flash';
    $('camera').append(f);
    setTimeout(() => f.remove(), 300);
    haptic();
    setCamFrozen(true);
    video.pause();
  }

  function onRetake() {
    setCamFrozen(false);
    $('cam-video').play().catch(() => {});
  }

  // 把畫面上的取景框換算成影片像素座標，外擴一點留給自動裁切找邊緣
  function guideRectInVideo(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const er = video.getBoundingClientRect();
    const g = $('cam-guide').getBoundingClientRect();
    const scale = Math.min(er.width / vw, er.height / vh); // object-fit: contain
    const offX = er.left + (er.width - vw * scale) / 2;
    const offY = er.top + (er.height - vh * scale) / 2;
    const m = 0.08 * Math.max(g.width, g.height);
    let x0 = (g.left - m - offX) / scale, y0 = (g.top - m - offY) / scale;
    let x1 = (g.right + m - offX) / scale, y1 = (g.bottom + m - offY) / scale;
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(vw, Math.round(x1)); y1 = Math.min(vh, Math.round(y1));
    if (x1 - x0 < 50 || y1 - y0 < 50) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function onUsePhoto() {
    const still = $('cam-still');
    // 只保留取景框附近的畫面
    const r = cam.crop || { x: 0, y: 0, w: still.width, h: still.height };
    const copy = document.createElement('canvas');
    copy.width = r.w; copy.height = r.h;
    copy.getContext('2d').drawImage(still, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    closeCamera();
    processImage(copy);
  }

  async function onTorch() {
    if (!cam.track) return;
    cam.torch = !cam.torch;
    try {
      await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
      $('cam-torch').classList.toggle('strong', cam.torch);
    } catch (e) { /* 不支援就算了 */ }
  }

  $('btn-camera').addEventListener('click', openCamera);
  $('cam-shutter').addEventListener('click', onShutter);
  $('cam-cancel').addEventListener('click', closeCamera);
  $('cam-retake').addEventListener('click', onRetake);
  $('cam-use').addEventListener('click', onUsePhoto);
  $('cam-torch').addEventListener('click', onTorch);
  // App 切到背景時關掉相機，避免一直佔用
  document.addEventListener('visibilitychange', () => { if (document.hidden && cam.stream && !$('camera').classList.contains('frozen')) closeCamera(); });

  // 使用者手動改過的欄位就不再標示為自動填入
  els.form.addEventListener('input', (e) => {
    const name = e.target.name;
    if (currentImage) currentImage.autoFilled.delete(name);
    const row = e.target.closest('.row');
    if (row) row.classList.remove('autofill');
  });

  // ---------- CSV ----------
  function csvCell(key, v) {
    let s = String(v == null ? '' : v);
    if (PHONE_FIELDS.has(key)) {
      // 避免 Excel 把 +886… 當公式、把 0912345678 去掉前導 0
      s = s.split(' / ').map((p) => p.replace(/^\+(\d{1,3})[-\s]?/, '(+$1) ')).join(' / ');
      if (/^0\d+$/.test(s)) s = CardParser.formatPhone(s);
    } else if (/^[=+\-@\t\r]/.test(s)) {
      s = "'" + s; // 防 CSV 公式注入
    }
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function buildCsv(rows) {
    const header = [...FIELDS.map(([, label]) => label), '建立時間'];
    const lines = [header.map((h) => '"' + h + '"').join(',')];
    rows.forEach((c) => {
      const cells = FIELDS.map(([k]) => csvCell(k, c[k]));
      cells.push(csvCell('createdAt', formatDate(c.createdAt)));
      lines.push(cells.join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 完整備份 / 還原 ----------
  const BACKUP_APP = 'card-scanner';

  async function onBackup() {
    const all = await getAll();
    if (!all.length) { toast('還沒有名片可以備份'); return; }
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `名片備份_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
    const payload = JSON.stringify({ app: BACKUP_APP, version: 1, exportedAt: d.toISOString(), count: all.length, cards: all });
    const ok = await shareFile(payload, filename, 'application/json');
    if (ok) toast(`已打包 ${all.length} 張名片（${(payload.length / 1048576).toFixed(1)} MB）`, 3000);
  }

  async function onRestore(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      toast('檔案無法讀取，請確認是名片備份檔', 3000);
      return;
    }
    if (!data || data.app !== BACKUP_APP || !Array.isArray(data.cards)) {
      toast('這不是名片掃描 App 的備份檔', 3000);
      return;
    }
    const existing = new Map((await getAll()).map((c) => [c.id, c]));
    const toPut = [];
    let skipped = 0;
    data.cards.forEach((c) => {
      if (!c || typeof c.id !== 'string') return;
      const cur = existing.get(c.id);
      // 同一張名片只保留比較新的版本
      if (cur && (cur.updatedAt || cur.createdAt || '') >= (c.updatedAt || c.createdAt || '')) { skipped++; return; }
      const clean = { id: c.id, createdAt: c.createdAt || new Date().toISOString(), updatedAt: c.updatedAt || c.createdAt };
      FIELDS.forEach(([k]) => { clean[k] = typeof c[k] === 'string' ? c[k] : ''; });
      if (typeof c.thumb === 'string' && c.thumb.startsWith('data:image/')) clean.thumb = c.thumb;
      if (typeof c.rawText === 'string') clean.rawText = c.rawText;
      if (typeof c.ocrBy === 'string') clean.ocrBy = c.ocrBy;
      toPut.push(clean);
    });
    if (!toPut.length) { toast(skipped ? `沒有新資料，${skipped} 張已經存在` : '備份檔裡沒有名片', 3000); return; }
    if (!confirm(`要從備份還原 ${toPut.length} 張名片嗎？${skipped ? `（另有 ${skipped} 張已存在，會略過）` : ''}`)) return;
    await putMany(toPut);
    await refresh();
    toast(`已還原 ${toPut.length} 張名片`, 3000);
    show('list');
  }

  async function onExport() {
    if (!cards.length) { toast('還沒有名片可以匯出'); return; }
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `名片_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    // iPhone 主畫面 App 用分享面板最穩：可存到「檔案」、AirDrop、Email、LINE
    const ok = await shareFile(buildCsv(cards), filename, 'text/csv');
    if (ok) toast(`已匯出 ${cards.length} 張名片`);
  }

  // ---------- 綁定 ----------
  $('file-camera').addEventListener('change', onFile);
  $('file-photo').addEventListener('change', onFile);
  $('btn-manual').addEventListener('click', () => openEdit(null));
  $('btn-cancel').addEventListener('click', onCancel);
  $('btn-save').addEventListener('click', onSave);
  $('btn-delete').addEventListener('click', onDelete);
  $('btn-export').addEventListener('click', onExport);
  $('btn-backup').addEventListener('click', onBackup);
  $('file-restore').addEventListener('change', onRestore);
  $('btn-detail-back').addEventListener('click', () => show('list'));
  $('btn-detail-edit').addEventListener('click', () => current && openEdit(current));
  $('btn-vcard').addEventListener('click', onVcard);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-back').addEventListener('click', leaveSettings);
  $('d-photo').addEventListener('click', () => { $('lightbox-img').src = $('d-photo').src; $('lightbox').hidden = false; });
  $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });
  els.rotate.addEventListener('click', onRotate);
  els.search.addEventListener('input', renderList);
  els.form.addEventListener('submit', (e) => { e.preventDefault(); onSave(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // 提早在背景載入辨識引擎，拍照後等比較短
  renderFootnote();
  function hideSplash() {
    const sp = $('splash');
    if (!sp || sp.classList.contains('hide')) return;
    sp.classList.add('hide');
    setTimeout(() => sp.remove(), 350);
  }
  setTimeout(hideSplash, 4000); // 保險：資料庫卡住也不要一直停在啟動畫面
  refresh().then(() => {
    hideSplash();
    if (useAI()) return; // AI 模式不必預載本機引擎
    const warm = () => getWorker().catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1500);
  });

  // 測試用
  window.__cardScanner = { buildCsv, buildVcard, refresh };
})();
