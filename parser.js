// 名片 OCR 文字 → 結構化欄位
// 純函式，瀏覽器與 Node 都能跑（方便測試）
(function (root) {
  'use strict';

  const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
  const reCJK = new RegExp('[' + CJK + ']');

  const SURNAMES = '王李張劉陳楊黃趙吳周徐孫馬朱胡郭何高林羅鄭梁謝宋唐許韓馮鄧曹彭曾蕭田董袁潘于蔣蔡余杜葉程蘇魏呂丁任沈姚盧姜崔鍾譚陸汪范金石廖賈夏韋付方白鄒孟熊秦邱江尹薛閻段雷侯龍史陶黎賀顧毛郝龔邵萬錢嚴覃武戴莫孔向湯游柯洪詹賴翁施莊温溫童凃涂巫藍簡歐顏傅鄞';
  const COMPOUND_SURNAMES = ['歐陽', '司馬', '諸葛', '上官', '張簡', '范姜', '東方', '皇甫', '公孫', '慕容'];

  const COMPANY_RE = /(股份有限公司|有限公司|公司|集團|企業社|企業|工業|實業|科技|材料|大學|研究院|研究所|學院|醫院|事務所|銀行|協會|基金會|工研院)|\b(Co\.?,?\s*,?\s*Ltd\.?|Inc\.?|Corp\.?|Corporation|Company|Limited|GmbH|LLC|L\.L\.C|Technolog(y|ies)|Materials?|University|Institute|Group|Holdings?)\b/i;
  const TITLE_RE = /(董事長|副董事長|總經理|副總經理|執行長|營運長|技術長|財務長|副總裁|總裁|副總|協理|經理|副理|襄理|處長|副處長|部長|課長|組長|科長|主任|主管|廠長|所長|院長|主席|總監|監事|董事|特助|助理|專員|工程師|研究員|顧問|教授|副教授|助理教授|博士|業務|代表|秘書|會計|技師|設計師|分析師|律師|建築師|醫師|負責人|創辦人|合夥人)|\b(CEO|CTO|CFO|COO|CIO|VP|SVP|EVP|AVP|President|Vice President|Chairman|Director|Manager|Engineer|Supervisor|Specialist|Consultant|Assistant|Professor|Researcher|Scientist|Sales|Representative|Founder|Partner|Owner|Head|Lead|Officer|Executive|Coordinator|Analyst|Designer|Architect|Ph\.?D)\b/i;
  const DEPT_RE = /([^\s]{1,12}?(部|處|中心|事業群|事業部|事業處|實驗室|研究室|課|室|組))(?=\s|$|[^一-鿿])|\b([A-Z][A-Za-z&\s]{1,40}(Division|Department|Dept\.?|Center|Centre|Lab|Laboratory|BU|Group))\b/;
  const ADDR_CJK_RE = /((市|縣|區|鄉|鎮)[^,，]*(路|街|大道|段|巷|弄|號|樓))|((路|街|大道)[^,，]*號)/;
  const ADDR_EN_RE = /\b(\d+[A-Za-z]?\s*F\.?|No\.\s*\d+|\d+\s*,?\s*(Sec\.|Section|Ln\.|Lane|Alley|Aly\.))|\b(Rd\.?|Road|St\.?|Street|Ave\.?|Avenue|Blvd\.?|Dist\.?|District|Hsinchu|Taipei|Taichung|Tainan|Kaohsiung|Taoyuan|Taiwan|R\.?O\.?C\.?)\b/i;
  const LABEL_RE = /^(姓名|名字|Name|職稱|Title|公司|Company|地址|住址|Add(ress)?|Addr|電話|Tel|Phone|手機|行動|Mobile|Mob|Cell|傳真|Fax|E-?mail|郵件|信箱|網址|網站|Web(site)?|URL|部門|Dept)\s*[:：.]?\s*/i;

  const MOBILE_LABEL = /(手機|行動|Mobile|Mob|Cell|\bM\b|\bH\/P\b|HP)/i;
  const FAX_LABEL = /(傳真|Fax|\bF\b)/i;
  const TEL_LABEL = /(電話|總機|直撥|分機|Tel|Phone|\bT\b|\bO\b|Office|Direct)/i;

  function cleanLine(s) {
    return s
      .replace(new RegExp('([' + CJK + '])\\s+(?=[' + CJK + '])', 'g'), '$1')
      .replace(/[｜|]{1,}/g, ' ')
      .replace(/＠/g, '@')
      .replace(/：/g, ':')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function stripLabel(s) {
    return s.replace(LABEL_RE, '').trim();
  }

  function digitsOf(s) {
    return (s.match(/\d/g) || []).join('');
  }

  // 台灣號碼加上分隔，避免 Excel 吃掉開頭的 0
  function formatPhone(raw) {
    let s = raw.replace(/[()（）]/g, (c) => (c === '(' || c === '（' ? '(' : ')')).trim();
    s = s.replace(/\s*(ext\.?|#|轉|分機)\s*/i, ' #');
    const [main, ext] = s.split(' #');
    const d = digitsOf(main);
    let out = main.trim();
    if (/^0\d{8,9}$/.test(d)) {
      if (/^09/.test(d)) out = d.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3');
      else if (/^0(2|4|7|8)\d{8}$/.test(d)) out = d.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3');
      else if (/^0(2|4|7|8)\d{7}$/.test(d)) out = d.replace(/^(\d{2})(\d{3})(\d{4})$/, '$1-$2-$3');
      else if (/^03\d{7}$/.test(d)) out = d.replace(/^(\d{2})(\d{3})(\d{4})$/, '$1-$2-$3');
      else if (/^0\d{9}$/.test(d)) out = d.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
      else out = d.replace(/^(\d{2,3})(\d{3})(\d{4})$/, '$1-$2-$3');
    } else if (/^886\d{8,9}$/.test(d) && /\+?886/.test(main)) {
      const local = d.slice(3);
      if (/^9/.test(local)) out = '+886-' + local.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1-$2-$3');
      else out = '+886-' + local.replace(/^(\d)(\d{3,4})(\d{4})$/, '$1-$2-$3');
    } else {
      out = out.replace(/\s+/g, ' ');
    }
    return ext ? out + ' #' + digitsOf(ext) : out;
  }

  function isMobileNumber(d) {
    return /^09\d{8}$/.test(d) || /^8869\d{8}$/.test(d);
  }

  const PHONE_RE = /(\+?\(?\d[\d\s\-().]{5,}\d)(\s*(?:ext\.?|#|轉|分機)\s*\d{1,6})?/gi;

  function extractPhones(line) {
    const found = [];
    let m;
    PHONE_RE.lastIndex = 0;
    while ((m = PHONE_RE.exec(line))) {
      const num = m[0];
      const d = digitsOf(m[1]);
      if (d.length < 8 || d.length > 15) continue;
      const before = line.slice(Math.max(0, m.index - 12), m.index);
      let kind = null;
      if (MOBILE_LABEL.test(before)) kind = 'mobile';
      else if (FAX_LABEL.test(before)) kind = 'fax';
      else if (TEL_LABEL.test(before)) kind = 'tel';
      found.push({ raw: num, digits: d, kind, labelled: !!kind });
    }
    return found;
  }

  function splitNameLine(s) {
    // 「王小明 Ming Wang」 → 中文 + 英文
    const cjk = (s.match(new RegExp('[' + CJK + ']+', 'g')) || []).join('');
    const latin = s.replace(new RegExp('[' + CJK + ']', 'g'), ' ').replace(/\s+/g, ' ').trim();
    return { cjk, latin };
  }

  function nameScore(cjk) {
    if (!/^[㐀-鿿]{2,4}$/.test(cjk)) return 0;
    let score = 1;
    if (COMPOUND_SURNAMES.some((x) => cjk.startsWith(x)) && cjk.length >= 3) score += 3;
    else if (SURNAMES.includes(cjk[0])) score += 3;
    if (cjk.length === 3) score += 1;
    return score;
  }

  function looksLikeEnglishName(s) {
    const t = s.replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 32) return false;
    if (COMPANY_RE.test(t) || TITLE_RE.test(t) || ADDR_EN_RE.test(t)) return false;
    const words = t.split(' ');
    if (words.length < 2 || words.length > 4) return false;
    return words.every((w) => /^[A-Z][a-zA-Z'\-]*$/.test(w) || /^[A-Z]{2,}(-[A-Z]{2,})?$/.test(w));
  }

  function parseCard(text) {
    const result = {
      name: '', nameEn: '', company: '', department: '', title: '',
      mobile: '', phone: '', fax: '', email: '', website: '', address: '', note: '',
    };
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(cleanLine)
      .filter((l) => l.replace(/[^\w㐀-鿿]/g, '').length >= 2);

    const used = new Set();

    // Email
    lines.forEach((l, i) => {
      const compact = l.replace(/\s+/g, '');
      const m = compact.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
      if (m && !result.email) {
        result.email = m[0].replace(/^(e-?mail|mail)[:：]?/i, '').toLowerCase();
        if (compact.replace(m[0], '').replace(LABEL_RE, '').length < 4) used.add(i);
      }
    });

    // 網址
    lines.forEach((l, i) => {
      if (result.website) return;
      const m = l.replace(/\s+/g, '').match(/((https?:\/\/)?(www\.)[A-Za-z0-9\-.]+\.[A-Za-z]{2,}[^\s,，]*)|(https?:\/\/[^\s,，]+)/i);
      if (m && !m[0].includes('@')) {
        result.website = m[0].toLowerCase();
        if (l.replace(/\s+/g, '').replace(m[0], '').replace(LABEL_RE, '').length < 4) used.add(i);
      }
    });

    // 地址（可能跨兩行）
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const l = stripLabel(lines[i]);
      if (ADDR_CJK_RE.test(l) && !result.address) {
        let addr = l;
        const next = lines[i + 1];
        if (next && !used.has(i + 1) && /^[\d\-之]*(樓|F|室)/.test(next.trim())) {
          addr += next.trim();
          used.add(i + 1);
        }
        result.address = addr.replace(/\s+/g, '');
        used.add(i);
      }
    }
    if (!result.address) {
      for (let i = 0; i < lines.length; i++) {
        if (used.has(i)) continue;
        const l = stripLabel(lines[i]);
        const hits = (l.match(new RegExp(ADDR_EN_RE.source, 'gi')) || []).length;
        if (hits >= 2 && /\d/.test(l) && extractPhones(l).length === 0) {
          let addr = l;
          const next = lines[i + 1];
          if (next && !used.has(i + 1) && /^(Taiwan|R\.?O\.?C|[A-Z][a-z]+ (City|County))/i.test(next.trim())) {
            addr += ', ' + next.trim();
            used.add(i + 1);
          }
          result.address = addr;
          used.add(i);
          break;
        }
      }
    }

    // 電話 / 手機 / 傳真
    const phones = [];
    lines.forEach((l, i) => {
      if (used.has(i) && !/(tel|fax|電話|傳真|手機)/i.test(l)) return;
      const ps = extractPhones(l);
      if (!ps.length) return;
      ps.forEach((p) => phones.push(p));
      const rest = l.replace(PHONE_RE, '').replace(/(Tel|Phone|Fax|Mobile|Mob|Cell|電話|傳真|手機|行動|總機|直撥|\bT\b|\bF\b|\bM\b)\s*[:.]?/gi, '').replace(/[\s,;/]/g, '');
      if (rest.length < 4) used.add(i);
    });
    phones.forEach((p) => {
      const kind = p.kind || (isMobileNumber(p.digits) ? 'mobile' : 'tel');
      const key = kind === 'mobile' ? 'mobile' : kind === 'fax' ? 'fax' : 'phone';
      const formatted = formatPhone(p.raw);
      if (!result[key]) result[key] = formatted;
      else if (key !== 'fax' && !result[key].includes(formatted)) result[key] += ' / ' + formatted;
    });

    // 公司
    const companyCands = [];
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      const s = stripLabel(l);
      if (COMPANY_RE.test(s) && s.length <= 60) {
        let score = 1;
        if (/(股份有限公司|有限公司)$/.test(s.replace(/\s/g, ''))) score += 4;
        else if (/(公司|集團|大學|研究院|醫院)/.test(s)) score += 3;
        if (/(Co\.?,?\s*Ltd|Inc|Corp|Corporation|Limited)/i.test(s)) score += 2;
        if (reCJK.test(s)) score += 1;
        if (TITLE_RE.test(s) && !/(公司|Co\.|Inc|Corp)/i.test(s)) score -= 3;
        companyCands.push({ i, s, score });
      }
    });
    companyCands.sort((a, b) => b.score - a.score);
    if (companyCands.length && companyCands[0].score > 0) {
      result.company = companyCands[0].s;
      used.add(companyCands[0].i);
      // 中英文公司名都有時，英文放到備註
      const en = companyCands.find((c) => c !== companyCands[0] && !reCJK.test(c.s) && c.score > 0);
      if (en && reCJK.test(result.company)) {
        result.note = appendNote(result.note, en.s);
        used.add(en.i);
      }
    }

    // 職稱 / 部門
    const titleLines = [];
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      const s = stripLabel(l);
      if (s.length > 40) return;
      if (TITLE_RE.test(s) || DEPT_RE.test(s)) titleLines.push({ i, s });
    });

    // 姓名：先找中文，可能和職稱在同一行（「王小明 經理」）
    const nameCands = [];
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      const s = stripLabel(l);
      const { cjk, latin } = splitNameLine(s);
      const titleMatch = cjk.match(TITLE_RE);
      let cjkName = cjk;
      let titleFromLine = '';
      if (titleMatch && cjk.indexOf(titleMatch[0]) > 1) {
        cjkName = cjk.slice(0, cjk.indexOf(titleMatch[0]));
        titleFromLine = cjk.slice(cjk.indexOf(titleMatch[0]));
      }
      const score = nameScore(cjkName);
      if (score > 0) {
        let sc = score + (i < lines.length / 2 ? 1 : 0);
        if (/^(姓名|Name)/i.test(l)) sc += 5;
        nameCands.push({ i, name: cjkName, latin, titleFromLine, score: sc });
      }
    });
    nameCands.sort((a, b) => b.score - a.score);
    if (nameCands.length) {
      const c = nameCands[0];
      result.name = c.name;
      used.add(c.i);
      if (c.latin && looksLikeEnglishName(c.latin)) result.nameEn = c.latin;
      if (c.titleFromLine) result.title = c.titleFromLine;
    }

    // 英文姓名
    if (!result.nameEn) {
      lines.forEach((l, i) => {
        if (result.nameEn || used.has(i)) return;
        const s = stripLabel(l);
        if (!reCJK.test(s) && looksLikeEnglishName(s)) {
          result.nameEn = s.replace(/\s+/g, ' ');
          used.add(i);
        }
      });
    }

    // 職稱 / 部門
    const titleParts = [];
    const titleEn = [];
    titleLines.forEach(({ i, s }) => {
      if (used.has(i)) return;
      used.add(i);
      const isCJK = reCJK.test(s);
      let dm = s.match(DEPT_RE);
      const tm = s.match(TITLE_RE);
      if (isCJK && tm && tm.index > 0 && !result.department) {
        // 「研發處資深經理」：職稱前面最後一個部門關鍵字之前都算部門
        const prefix = s.slice(0, tm.index);
        const km = prefix.match(/^(.*(部|處|中心|事業群|實驗室|研究室|課|室|組))/);
        if (km) {
          result.department = km[1].trim();
          titleParts.push(s.slice(km[1].length).trim());
          return;
        }
      }
      if (dm &&(!tm || dm.index < tm.index) && !result.department) {
        const dept = dm[0].trim();
        result.department = dept;
        const rest = s.replace(dept, '').trim();
        if (rest && TITLE_RE.test(rest)) (isCJK ? titleParts : titleEn).push(rest);
      } else if (tm) {
        (isCJK ? titleParts : titleEn).push(s);
      } else if (dm && result.department && !result.department.includes(dm[0])) {
        result.department += ' ' + dm[0].trim();
      }
    });
    const titleAll = [result.title, ...titleParts].filter(Boolean);
    if (titleAll.length) result.title = titleAll.join(' ');
    if (titleEn.length) {
      if (!result.title) result.title = titleEn.join(' ');
      else result.note = appendNote(result.note, titleEn.join(' '));
    }

    return result;
  }

  function appendNote(note, s) {
    return note ? note + '；' + s : s;
  }

  const api = { parseCard, formatPhone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CardParser = api;
})(typeof self !== 'undefined' ? self : this);
