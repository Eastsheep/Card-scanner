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
    list: $('list'), empty: $('empty'), count: $('count'), search: $('search'),
    viewList: $('view-list'), viewEdit: $('view-edit'), form: $('form'),
    preview: $('preview'), previewWrap: $('preview-wrap'),
    ocrStatus: $('ocr-status'), ocrBar: $('ocr-bar'), ocrMsg: $('ocr-msg'),
    raw: $('raw'), rawWrap: $('raw-wrap'), danger: $('danger'), editTitle: $('edit-title'),
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

  // 加到主畫面後，要求瀏覽器不要自動清掉資料
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // ---------- 狀態 ----------
  let cards = [];
  let editing = null; // 目前編輯中的紀錄
  let currentImage = null; // { canvas, rotation }
  let ocrRun = 0;

  function toast(msg, ms = 2400) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
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
    els.count.textContent = `${cards.length} 張名片`;
    els.empty.hidden = cards.length > 0;
    els.list.replaceChildren(...shown.map(renderItem));
  }

  function renderItem(c) {
    const li = document.createElement('li');
    li.className = 'item';
    const thumb = c.thumb ? document.createElement('img') : document.createElement('div');
    if (c.thumb) { thumb.src = c.thumb; thumb.alt = ''; } else { thumb.className = 'ph'; thumb.textContent = '無圖'; }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = c.name || c.nameEn || '（未填姓名）';
    if (c.title) { const s = document.createElement('small'); s.textContent = c.title; n.append(s); }
    const co = document.createElement('div');
    co.className = 'c';
    co.textContent = c.company || '';
    const p = document.createElement('div');
    p.className = 'p';
    p.textContent = c.mobile || c.phone || c.email || '';
    meta.append(n, co, p);
    li.append(thumb, meta);
    li.addEventListener('click', () => openEdit(c));
    return li;
  }

  // ---------- 編輯畫面 ----------
  function show(view) {
    els.viewList.hidden = view !== 'list';
    els.viewEdit.hidden = view !== 'edit';
    window.scrollTo(0, 0);
  }

  function fillForm(data) {
    FIELDS.forEach(([k]) => { els.form.elements[k].value = data[k] || ''; });
  }

  function readForm() {
    const out = {};
    FIELDS.forEach(([k]) => { out[k] = els.form.elements[k].value.trim(); });
    return out;
  }

  function openEdit(card) {
    editing = card ? { ...card } : { id: newId(), createdAt: new Date().toISOString() };
    currentImage = null;
    ocrRun++;
    fillForm(editing);
    els.editTitle.textContent = card ? '編輯名片' : '新名片';
    els.danger.hidden = !card;
    els.previewWrap.hidden = !editing.thumb;
    els.rotate.hidden = true;
    if (editing.thumb) els.preview.src = editing.thumb;
    els.raw.textContent = editing.rawText || '';
    els.rawWrap.hidden = !editing.rawText;
    els.ocrStatus.hidden = true;
    els.save.disabled = false;
    show('edit');
  }

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  }

  async function onSave() {
    const data = readForm();
    if (!Object.values(data).some(Boolean)) { toast('至少填一個欄位'); return; }
    const rec = { ...editing, ...data, updatedAt: new Date().toISOString() };
    await putCard(rec);
    toast('已儲存');
    await refresh();
    show('list');
  }

  async function onDelete() {
    if (!editing) return;
    if (!confirm(`確定刪除「${editing.name || editing.company || '這張名片'}」？`)) return;
    await deleteCard(editing.id);
    toast('已刪除');
    await refresh();
    show('list');
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
    'loading tesseract core': '載入辨識引擎…',
    'initializing tesseract': '初始化…',
    'loading language traineddata': '載入中英文字庫（第一次較久）…',
    'initializing api': '初始化…',
    'recognizing text': '辨識文字中…',
  };

  async function runOcr() {
    if (!currentImage) return;
    const run = ++ocrRun;
    els.ocrStatus.hidden = false;
    els.ocrBar.style.width = '0%';
    els.ocrMsg.textContent = '準備中…';
    els.rotate.disabled = true;
    progressCb = (m) => {
      if (run !== ocrRun) return;
      els.ocrMsg.textContent = STATUS_TEXT[m.status] || m.status;
      els.ocrBar.style.width = Math.round((m.progress || 0) * 100) + '%';
    };
    try {
      const rotated = drawScaled(currentImage.img, 2400, currentImage.rotation);
      const worker = await getWorker();
      const { data } = await worker.recognize(toOcrCanvas(rotated));
      if (run !== ocrRun) return;
      const text = data.text || '';
      const parsed = CardParser.parseCard(text);
      // 已經手動填的欄位不覆蓋
      const cur = readForm();
      FIELDS.forEach(([k]) => { if (!cur[k] || currentImage.autoFilled.has(k)) { els.form.elements[k].value = parsed[k] || ''; if (parsed[k]) currentImage.autoFilled.add(k); } });
      els.raw.textContent = text.trim();
      els.rawWrap.hidden = !text.trim();
      editing.rawText = text.trim();
      els.ocrMsg.textContent = text.trim() ? '辨識完成，請核對欄位後儲存' : '沒辨識到文字，可旋轉後再試或手動輸入';
      els.ocrBar.style.width = '100%';
      setTimeout(() => { if (run === ocrRun) els.ocrStatus.hidden = true; }, 2500);
    } catch (e) {
      console.error(e);
      if (run !== ocrRun) return;
      els.ocrMsg.textContent = '辨識失敗：' + (e && e.message ? e.message : e) + '（可手動輸入）';
    } finally {
      if (run === ocrRun) els.rotate.disabled = false;
    }
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    openEdit(null);
    try {
      const img = await loadImage(file);
      const thumb = drawScaled(img, 640).toDataURL('image/jpeg', 0.75);
      editing.thumb = thumb;
      els.preview.src = thumb;
      els.previewWrap.hidden = false;
      els.rotate.hidden = false;
      currentImage = { img, rotation: 0, autoFilled: new Set() };
      runOcr();
    } catch (err) {
      toast(err.message || '無法讀取圖片');
    }
  }

  function onRotate() {
    if (!currentImage) return;
    currentImage.rotation = (currentImage.rotation + 90) % 360;
    const t = drawScaled(currentImage.img, 640, currentImage.rotation);
    editing.thumb = t.toDataURL('image/jpeg', 0.75);
    els.preview.src = editing.thumb;
    runOcr();
  }

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
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function onExport() {
    if (!cards.length) { toast('還沒有名片可以匯出'); return; }
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const filename = `名片_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
    const blob = new Blob([buildCsv(cards)], { type: 'text/csv;charset=utf-8' });
    const file = new File([blob], filename, { type: 'text/csv' });
    // iPhone 主畫面 App 用分享面板最穩：可存到「檔案」、AirDrop、Email、LINE
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
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
    toast(`已匯出 ${cards.length} 張名片`);
  }

  // ---------- 綁定 ----------
  $('file-camera').addEventListener('change', onFile);
  $('file-photo').addEventListener('change', onFile);
  $('btn-manual').addEventListener('click', () => openEdit(null));
  $('btn-cancel').addEventListener('click', () => { ocrRun++; show('list'); });
  $('btn-save').addEventListener('click', onSave);
  $('btn-delete').addEventListener('click', onDelete);
  $('btn-export').addEventListener('click', onExport);
  els.rotate.addEventListener('click', onRotate);
  els.search.addEventListener('input', renderList);
  els.form.addEventListener('submit', (e) => { e.preventDefault(); onSave(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // 提早在背景載入辨識引擎，拍照後等比較短
  refresh().then(() => {
    const warm = () => getWorker().catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1500);
  });

  // 測試用
  window.__cardScanner = { buildCsv, refresh };
})();
