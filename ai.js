// AI 名片辨識：把照片傳給 Claude，回傳結構化欄位
(function (root) {
  'use strict';

  const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（最準）' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（平衡）' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最快、最省）' },
  ];
  const DEFAULT_MODEL = MODELS[0].id;

  const FIELD_KEYS = ['name', 'nameEn', 'company', 'department', 'title', 'mobile', 'phone', 'fax', 'email', 'website', 'address', 'note'];

  const SCHEMA = {
    type: 'object',
    properties: {
      name: { type: 'string', description: '中文姓名（無則空字串）' },
      nameEn: { type: 'string', description: '英文姓名' },
      company: { type: 'string', description: '公司全名，有中文以中文為主' },
      department: { type: 'string', description: '部門' },
      title: { type: 'string', description: '職稱' },
      mobile: { type: 'string', description: '手機，多支用「 / 」分隔' },
      phone: { type: 'string', description: '公司電話/市話，分機寫成「 #分機號」' },
      fax: { type: 'string', description: '傳真' },
      email: { type: 'string', description: 'Email' },
      website: { type: 'string', description: '網址' },
      address: { type: 'string', description: '地址，有中文以中文為主' },
      note: { type: 'string', description: '其他值得保留的資訊：英文公司名、英文職稱、英文地址、LINE ID、統編、業務項目等' },
    },
    required: FIELD_KEYS,
    additionalProperties: false,
  };

  const SYSTEM = [
    '你是名片資料擷取助手。使用者會給你一張名片照片，請擷取聯絡資料並依 JSON schema 回傳。',
    '規則：',
    '- 只填名片上真的看得到的資訊，看不到或不確定就填空字串，不要猜測或補資料。',
    '- 中文一律使用繁體中文，保留名片原本的寫法。',
    '- 名片同時有中英文時：name/company/title/address 填中文，nameEn 填英文姓名，其餘英文版本（英文公司名、英文職稱、英文地址）放進 note。',
    '- 台灣電話格式化為：手機 0912-345-678、市話 02-2345-6789、03-578-1234；國際碼寫成 +886-2-2345-6789；分機寫成「 #2501」。',
    '- 有多支同類電話時用「 / 」分隔。',
    '- Email 與網址全部小寫。',
    '- 照片如果是名片的背面或不是名片，盡量擷取能讀到的資訊。',
  ].join('\n');

  let sdkPromise = null;
  function loadSdk() {
    if (root.Anthropic) return Promise.resolve(root.Anthropic);
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/anthropic-sdk.min.js';
        s.onload = () => resolve(root.Anthropic);
        s.onerror = () => { sdkPromise = null; reject(new Error('無法載入 AI 模組，請檢查網路')); };
        document.head.append(s);
      });
    }
    return sdkPromise;
  }

  function friendlyError(e) {
    const status = e && e.status;
    if (status === 401) return 'API Key 無效，請到設定檢查';
    if (status === 403) return 'API Key 沒有權限使用這個模型';
    if (status === 429) return 'AI 呼叫太頻繁或額度已用完，請稍後再試';
    if (status === 529 || (status >= 500 && status < 600)) return 'AI 服務暫時忙碌，請稍後再試';
    if (status === 400) return 'AI 請求格式錯誤：' + ((e.error && e.error.error && e.error.error.message) || e.message || '');
    if (e && /fetch|network|Connection/i.test(e.message || '')) return '網路連線失敗';
    return (e && e.message) || 'AI 辨識失敗';
  }

  // imageBase64: 不含 data: 前綴的 JPEG base64
  async function extract({ apiKey, model, imageBase64, signal }) {
    const Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 90000 });
    let response;
    try {
      response = await client.beta.messages.create({
        model: model || DEFAULT_MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        // 擷取資料不需要深度思考，用 low 加快速度、降低成本
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: SCHEMA },
        },
        // 若安全分類器誤擋，由伺服器自動改用建議的備援模型
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
              { type: 'text', text: '請擷取這張名片的資料。' },
            ],
          },
        ],
      }, { signal });
    } catch (e) {
      const err = new Error(friendlyError(e));
      err.cause = e;
      throw err;
    }

    if (response.stop_reason === 'refusal') throw new Error('AI 拒絕處理這張圖片');
    if (response.stop_reason === 'max_tokens') throw new Error('AI 回應被截斷，請重試');
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('AI 沒有回傳資料');
    let data;
    try {
      data = JSON.parse(textBlock.text);
    } catch (e) {
      throw new Error('AI 回傳格式無法解析');
    }
    const out = {};
    FIELD_KEYS.forEach((k) => { out[k] = typeof data[k] === 'string' ? data[k].trim() : ''; });
    return { fields: out, model: response.model, usage: response.usage };
  }

  // ---------- DeepSeek（OpenAI 相容格式） ----------
  const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
  const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash'; // 支援圖片輸入的模型

  const DEEPSEEK_SYSTEM = SYSTEM + '\n- 只輸出一個 JSON 物件，不要任何說明文字或 Markdown。JSON 欄位固定為：' +
    JSON.stringify(Object.fromEntries(FIELD_KEYS.map((k) => [k, SCHEMA.properties[k].description])));

  function deepseekError(status, body) {
    const msg = (body && body.error && body.error.message) || '';
    if (status === 401) return 'DeepSeek API Key 無效，請到設定檢查';
    if (status === 402) return 'DeepSeek 帳戶餘額不足，請先儲值';
    if (status === 429) return 'DeepSeek 呼叫太頻繁，請稍後再試';
    if (status >= 500) return 'DeepSeek 服務暫時忙碌，請稍後再試';
    return `DeepSeek 錯誤 ${status}${msg ? '：' + msg : ''}`;
  }

  function parseJsonLoose(text) {
    const t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 再試著抓第一個 {...} */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI 回傳格式無法解析');
  }

  // OpenAI 相容格式（DeepSeek、OpenRouter 共用）
  async function postChat(url, headers, body, name) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`無法連線 ${name}（網路問題或瀏覽器擋住跨網域請求）`);
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { res, json };
  }

  async function extractChat({ url, headers, name, errorFn, model, imageBase64 }) {
    const body = {
      model,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DEEPSEEK_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageBase64 } },
            { type: 'text', text: '請擷取這張名片的資料，以 json 輸出。' },
          ],
        },
      ],
    };
    let { res, json } = await postChat(url, headers, body, name);
    // 有些模型不接受 JSON mode，拿掉再試一次
    if (res.status === 400 || res.status === 422) {
      delete body.response_format;
      ({ res, json } = await postChat(url, headers, body, name));
    }
    if (!res.ok) throw new Error(errorFn(res.status, json));
    if (json && json.error) throw new Error(errorFn(json.error.code || 500, json));
    const choice = json && json.choices && json.choices[0];
    if (!choice || !choice.message) throw new Error('AI 沒有回傳資料');
    if (choice.finish_reason === 'length') throw new Error('AI 回應被截斷，請重試');
    const data = parseJsonLoose(choice.message.content);
    const out = {};
    FIELD_KEYS.forEach((k) => { out[k] = typeof data[k] === 'string' ? data[k].trim() : ''; });
    return { fields: out, model: json.model, usage: json.usage };
  }

  function extractDeepseek({ apiKey, model, imageBase64 }) {
    return extractChat({
      url: DEEPSEEK_URL, headers: { Authorization: 'Bearer ' + apiKey }, name: 'DeepSeek', errorFn: deepseekError,
      model: model || DEEPSEEK_DEFAULT_MODEL, imageBase64,
    });
  }

  // ---------- OpenRouter（一把 Key 用多家模型） ----------
  const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
  const OPENROUTER_DEFAULT_MODEL = 'google/gemini-2.5-flash';
  // 常用、支援圖片的模型建議（實際可用清單會向 OpenRouter 讀取）
  const OPENROUTER_SUGGEST = ['google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5', 'qwen/qwen2.5-vl-72b-instruct'];

  function openrouterError(status, body) {
    const msg = (body && body.error && body.error.message) || '';
    if (status === 401) return 'OpenRouter API Key 無效，請到設定檢查';
    if (status === 402) return 'OpenRouter 額度不足，請先儲值';
    if (status === 404) return `OpenRouter 找不到這個模型或它不支援圖片${msg ? '：' + msg : ''}`;
    if (status === 429) return 'OpenRouter 呼叫太頻繁，請稍後再試';
    if (status >= 500) return 'OpenRouter 或模型服務暫時忙碌，請稍後再試';
    return `OpenRouter 錯誤 ${status}${msg ? '：' + msg : ''}`;
  }

  function extractOpenrouter({ apiKey, model, imageBase64 }) {
    return extractChat({
      url: OPENROUTER_BASE + '/chat/completions',
      headers: { Authorization: 'Bearer ' + apiKey, 'HTTP-Referer': location.origin + location.pathname, 'X-Title': 'Card Scanner' },
      name: 'OpenRouter', errorFn: openrouterError,
      model: model || OPENROUTER_DEFAULT_MODEL, imageBase64,
    });
  }

  // 讀取 OpenRouter 上支援圖片輸入的模型（公開清單，不需 Key）
  async function listOpenrouterVisionModels() {
    const res = await fetch(OPENROUTER_BASE + '/models');
    if (!res.ok) throw new Error('讀取模型清單失敗');
    const json = await res.json();
    return ((json && json.data) || [])
      .filter((m) => m.architecture && (m.architecture.input_modalities || []).includes('image'))
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // 列出帳號可用的 DeepSeek 模型
  async function listDeepseekModels(apiKey) {
    let res;
    try {
      res = await fetch('https://api.deepseek.com/models', { headers: { Authorization: 'Bearer ' + apiKey } });
    } catch (e) {
      throw new Error('無法連線 DeepSeek（網路問題或瀏覽器擋住跨網域請求）');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error(deepseekError(res.status, json));
    return ((json && json.data) || []).map((m) => m.id).filter(Boolean).sort();
  }

  // 畫一張測試名片，送去辨識，檢查能否讀出關鍵欄位
  const SAMPLE = { name: '林測試', company: '測試材料股份有限公司', title: '專案經理', mobile: '0912-345-678', email: 'test@example.com' };
  function sampleCard() {
    const c = document.createElement('canvas');
    c.width = 900; c.height = 520;
    const g = c.getContext('2d');
    g.fillStyle = '#fbfaf7'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#1f4e79'; g.fillRect(0, 0, 14, c.height);
    const font = (px, w = 400) => `${w} ${px}px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
    g.fillStyle = '#1f4e79'; g.font = font(40, 700); g.fillText(SAMPLE.company, 60, 90);
    g.fillStyle = '#111'; g.font = font(64, 700); g.fillText(SAMPLE.name, 60, 220);
    g.fillStyle = '#444'; g.font = font(34); g.fillText(SAMPLE.title, 60, 275);
    g.font = font(30); g.fillStyle = '#222';
    g.fillText('Mobile: ' + SAMPLE.mobile, 60, 380);
    g.fillText('E-mail: ' + SAMPLE.email, 60, 430);
    return c;
  }

  async function testProvider(providerKey, { apiKey, model }) {
    const canvas = sampleCard();
    const url = canvas.toDataURL('image/jpeg', 0.9);
    const t0 = performance.now();
    const { fields, model: usedModel } = await PROVIDERS[providerKey].extract({ apiKey, model, imageBase64: url.slice(url.indexOf(',') + 1) });
    const ms = Math.round(performance.now() - t0);
    const norm = (v) => String(v || '').replace(/[\s\-]/g, '').toLowerCase();
    const checks = ['name', 'mobile', 'email'].map((k) => ({ key: k, ok: norm(fields[k]) === norm(SAMPLE[k]) }));
    return { ms, model: usedModel || model, fields, checks, image: url, passed: checks.filter((c) => c.ok).length };
  }

  const PROVIDERS = {
    deepseek: { label: 'DeepSeek', extract: extractDeepseek, defaultModel: DEEPSEEK_DEFAULT_MODEL },
    openrouter: { label: 'OpenRouter', extract: extractOpenrouter, defaultModel: OPENROUTER_DEFAULT_MODEL },
    claude: { label: 'Claude', extract, defaultModel: DEFAULT_MODEL },
  };

  root.CardAI = { extract, MODELS, DEFAULT_MODEL, PROVIDERS, DEEPSEEK_DEFAULT_MODEL, listDeepseekModels, testProvider, OPENROUTER_DEFAULT_MODEL, OPENROUTER_SUGGEST, listOpenrouterVisionModels };
})(self);
