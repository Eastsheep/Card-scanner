// AI 名片辨識：把照片傳給 Claude，回傳結構化欄位
(function (root) {
  'use strict';

  const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（最準）' },
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

  root.CardAI = { extract, MODELS, DEFAULT_MODEL };
})(self);
