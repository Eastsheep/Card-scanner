// 名片照片優化：找出名片四角 → 透視校正裁切 → 去陰影提亮
// 純 Canvas 實作，不需要額外函式庫
(function (root) {
  'use strict';

  const DETECT_SIZE = 480; // 偵測時縮小到這個長邊，速度快
  const OUT_MAX = 2000; // 輸出長邊上限

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function drawFit(src, maxSide) {
    const w0 = src.naturalWidth || src.width;
    const h0 = src.naturalHeight || src.height;
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const c = canvasOf(Math.max(1, Math.round(w0 * s)), Math.max(1, Math.round(h0 * s)));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, scale: s };
  }

  // ---------- 偵測 ----------
  function otsu(values) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < values.length; i++) hist[values[i]]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function morph(mask, w, h, r, dilate) {
    // 先橫向再縱向的方形結構元素
    const tmp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          const m = mask[y * w + xx];
          if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          const m = tmp[yy * w + x];
          if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function largestComponent(mask, w, h) {
    const label = new Int32Array(mask.length);
    const stack = new Int32Array(mask.length);
    let bestLabel = 0, bestSize = 0, cur = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || label[i]) continue;
      cur++;
      let sp = 0, size = 0;
      stack[sp++] = i;
      label[i] = cur;
      while (sp) {
        const p = stack[--sp];
        size++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    const pts = [];
    for (let i = 0; i < mask.length; i++) if (label[i] === bestLabel) pts.push([i % w, (i / w) | 0]);
    return { pts, size: bestSize };
  }

  // 只用每列最左最右的點算凸包，快很多
  function boundaryPoints(pts, w, h) {
    const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1);
    for (const [x, y] of pts) { if (x < minX[y]) minX[y] = x; if (x > maxX[y]) maxX[y] = x; }
    const out = [];
    for (let y = 0; y < h; y++) if (maxX[y] >= 0) { out.push([minX[y], y]); out.push([maxX[y] + 1, y]); }
    return out;
  }

  function convexHull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const pt of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const pt = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function polyArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  // 反覆移除「拿掉後面積損失最少」的頂點，直到剩 4 個
  function reduceToQuad(hull) {
    const poly = hull.slice();
    const triArea = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    while (poly.length > 4) {
      let minI = 0, minA = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = triArea(poly[(i - 1 + poly.length) % poly.length], poly[i], poly[(i + 1) % poly.length]);
        if (a < minA) { minA = a; minI = i; }
      }
      poly.splice(minI, 1);
    }
    return poly;
  }

  // 依左上、右上、右下、左下排序
  function orderCorners(q) {
    const cx = q.reduce((s, p) => s + p[0], 0) / 4;
    const cy = q.reduce((s, p) => s + p[1], 0) / 4;
    const sorted = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    // atan2 排序後是從左（-π）開始順時針：找 x+y 最小的當左上
    let start = 0, best = Infinity;
    sorted.forEach((p, i) => { if (p[0] + p[1] < best) { best = p[0] + p[1]; start = i; } });
    return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  }

  // 把遮罩轉成四個角；形狀不像名片就回傳 null
  function quadFromMask(mask, w, h) {
    const { pts, size } = largestComponent(mask, w, h);
    const frac = size / (w * h);
    if (frac < 0.12 || frac > 0.97) return null; // 太小可能沒抓到，太大代表名片本來就填滿畫面
    const hull = convexHull(boundaryPoints(pts, w, h));
    if (hull.length < 4) return null;
    const quad = reduceToQuad(hull);
    const qa = polyArea(quad);
    // 四邊形要和連通區域面積接近，否則形狀不像名片
    if (qa < size * 0.85 || qa > size * 1.25) return null;
    const ordered = orderCorners(quad);
    // 每個角不能太尖或太鈍
    for (let i = 0; i < 4; i++) {
      const a = ordered[(i + 3) % 4], b = ordered[i], c = ordered[(i + 1) % 4];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
      if (Math.abs(cos) > 0.6) return null;
    }
    return { quad: ordered, area: qa };
  }

  // 方法一：找邊緣，從畫面外圈往內灌水，灌不到的封閉區域就是名片（不怕陰影）
  function detectByEdges(d, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // 3x3 平均去雜訊
    const b = Float32Array.from(g); // 外框保留原值，避免邊界被當成邊緣
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * w + x + dx];
      b[y * w + x] = s / 9;
    }
    const mag = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1];
      const gy = b[i + w - 1] + 2 * b[i + w] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - w] - b[i - w + 1];
      const m = Math.hypot(gx, gy) / 4;
      mag[i] = m > 255 ? 255 : m;
    }
    const thr = Math.max(14, otsu(mag) * 0.6);
    let edge = new Uint8Array(w * h);
    for (let j = 0; j < mag.length; j++) edge[j] = mag[j] > thr ? 1 : 0;
    // 最外 2 圈不算邊緣，保證能從外圈開始灌水
    for (let x = 0; x < w; x++) for (let k = 0; k < 2; k++) { edge[k * w + x] = 0; edge[(h - 1 - k) * w + x] = 0; }
    for (let y = 0; y < h; y++) for (let k = 0; k < 2; k++) { edge[y * w + k] = 0; edge[y * w + w - 1 - k] = 0; }
    edge = morph(edge, w, h, 1, true); // 補上邊緣小缺口
    // 外圈灌水
    const bg = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const seed = (p) => { if (!edge[p] && !bg[p]) { bg[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      if (x > 0) seed(p - 1);
      if (x < w - 1) seed(p + 1);
      if (y > 0) seed(p - w);
      if (y < h - 1) seed(p + w);
    }
    let mask = new Uint8Array(w * h);
    for (let j = 0; j < mask.length; j++) mask[j] = bg[j] ? 0 : 1;
    mask = morph(mask, w, h, 2, false); // 去掉背景上的細線
    return quadFromMask(mask, w, h);
  }

  // 方法二：跟背景顏色比較（邊緣不完整時的備案）
  function detectByColor(d, w, h) {

    // 用外框一圈估計背景顏色（中位數）
    const border = [[], [], []];
    const pushPx = (x, y) => { const i = (y * w + x) * 4; border[0].push(d[i]); border[1].push(d[i + 1]); border[2].push(d[i + 2]); };
    const bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    for (let x = 0; x < w; x += 2) for (let k = 0; k < bw; k++) { pushPx(x, k); pushPx(x, h - 1 - k); }
    for (let y = 0; y < h; y += 2) for (let k = 0; k < bw; k++) { pushPx(k, y); pushPx(w - 1 - k, y); }
    const med = border.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);

    // 前景分數：與背景色的差距 + 亮度差（名片通常比桌面亮）
    const score = new Uint8Array(w * h);
    const bgL = 0.299 * med[0] + 0.587 * med[1] + 0.114 * med[2];
    for (let i = 0, j = 0; j < score.length; i += 4, j++) {
      const dr = d[i] - med[0], dg = d[i + 1] - med[1], db = d[i + 2] - med[2];
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.sqrt(dr * dr + dg * dg + db * db) * 0.8 + Math.max(0, L - bgL) * 0.6;
      score[j] = v > 255 ? 255 : v;
    }
    const thr = Math.max(18, otsu(score));
    let mask = new Uint8Array(w * h);
    for (let j = 0; j < score.length; j++) mask[j] = score[j] > thr ? 1 : 0;
    // 閉運算補洞，再開運算去雜點
    mask = morph(mask, w, h, 3, true);
    mask = morph(mask, w, h, 3, false);
    mask = morph(mask, w, h, 2, false);
    mask = morph(mask, w, h, 2, true);

    return quadFromMask(mask, w, h);
  }

  function detectCard(src) {
    const { canvas, scale } = drawFit(src, DETECT_SIZE);
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const a = detectByEdges(d, w, h);
    const b = a ? null : detectByColor(d, w, h);
    const found = a || b;
    if (!found) return null;
    const ordered = found.quad;
    // 往中心內縮一點，避免裁到一條背景邊
    const cx = ordered.reduce((t, p) => t + p[0], 0) / 4;
    const cy = ordered.reduce((t, p) => t + p[1], 0) / 4;
    const k = 0.012;
    // 換算回原圖座標
    return ordered.map(([x, y]) => [(x + (cx - x) * k) / scale, (y + (cy - y) * k) / scale]);
  }

  // ---------- 透視校正 ----------
  function solveHomography(srcPts, dstPts) {
    // 求從 dst 對應回 src 的矩陣（反向取樣用）
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = dstPts[i], [u, v] = srcPts[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    // 高斯消去
    const n = 8;
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    return b.map((v, i) => v / A[i][i]).concat(1);
  }

  function warp(src, corners) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const [tl, tr, br, bl] = corners;
    let W = Math.max(dist(tl, tr), dist(bl, br));
    let H = Math.max(dist(tl, bl), dist(tr, br));
    // 角度很斜時邊長比例會失真；接近標準名片比例（9×5.4 cm）就直接採用標準比例
    const STD = 9 / 5.4;
    const ratio = W / H;
    if (ratio > 1 && Math.abs(ratio / STD - 1) < 0.25) H = W / STD;
    else if (ratio < 1 && Math.abs((1 / ratio) / STD - 1) < 0.25) W = H / STD;
    const s = Math.min(1, OUT_MAX / Math.max(W, H));
    W = Math.round(W * s); H = Math.round(H * s);

    // 來源縮到足夠大就好，省記憶體
    const srcFit = drawFit(src, Math.max(OUT_MAX * 1.3, 1));
    const sc = srcFit.scale;
    const sw = srcFit.canvas.width, sh = srcFit.canvas.height;
    const sd = srcFit.canvas.getContext('2d').getImageData(0, 0, sw, sh).data;
    const Hm = solveHomography(corners.map(([x, y]) => [x * sc, y * sc]), [[0, 0], [W, 0], [W, H], [0, H]]);

    const out = canvasOf(W, H);
    const octx = out.getContext('2d');
    const img = octx.createImageData(W, H);
    const od = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const den = Hm[6] * x + Hm[7] * y + 1;
        let u = (Hm[0] * x + Hm[1] * y + Hm[2]) / den;
        let v = (Hm[3] * x + Hm[4] * y + Hm[5]) / den;
        u = Math.min(sw - 1.001, Math.max(0, u));
        v = Math.min(sh - 1.001, Math.max(0, v));
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          od[o + c] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // ---------- 光線優化 ----------
  // 估計整張的照明（大範圍模糊後的亮部），用除法拉平陰影，再做對比拉伸
  function relight(canvas) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    // 小尺寸亮度圖 → 最大值濾波（去掉文字）→ 模糊 = 照明圖
    const sw = Math.max(8, Math.round(w / 16)), sh = Math.max(8, Math.round(h / 16));
    const small = canvasOf(sw, sh);
    const sctx = small.getContext('2d');
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const sdat = sctx.getImageData(0, 0, sw, sh);
    const L = new Float32Array(sw * sh);
    for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = 0.299 * sdat.data[i] + 0.587 * sdat.data[i + 1] + 0.114 * sdat.data[i + 2];
    const r = 2;
    const mx = new Float32Array(L.length);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy));
        if (L[yy * sw + xx] > m) m = L[yy * sw + xx];
      }
      mx[y * sw + x] = m;
    }
    for (let j = 0, i = 0; j < mx.length; j++, i += 4) { sdat.data[i] = sdat.data[i + 1] = sdat.data[i + 2] = mx[j]; sdat.data[i + 3] = 255; }
    sctx.putImageData(sdat, 0, 0);
    // 放大回原尺寸時瀏覽器做平滑插值，再加一點模糊
    const illum = canvasOf(w, h);
    const ictx = illum.getContext('2d');
    ictx.imageSmoothingEnabled = true;
    ictx.imageSmoothingQuality = 'high';
    if ('filter' in ictx) ictx.filter = `blur(${Math.round(Math.max(w, h) / 60)}px)`;
    ictx.drawImage(small, 0, 0, w, h);
    const il = ictx.getImageData(0, 0, w, h).data;

    // 除以照明，讓白底變白、陰影消失
    const lum = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const k = 242 / Math.max(40, il[i]);
      const f = Math.min(3, k);
      d[i] = Math.min(255, d[i] * f);
      d[i + 1] = Math.min(255, d[i + 1] * f);
      d[i + 2] = Math.min(255, d[i + 2] * f);
      lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    // 對比拉伸：最暗 1% 變黑，最亮 2% 變白
    const hist = new Uint32Array(256);
    for (let j = 0; j < lum.length; j++) hist[lum[j]]++;
    const pct = (p) => { let acc = 0; const target = lum.length * p; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; } return 255; };
    const lo = pct(0.01), hi = Math.max(lo + 30, pct(0.98));
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo))));
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // 回傳 { canvas, cropped }，失敗時 cropped=false 只做光線優化
  function enhance(src) {
    let corners = null;
    try { corners = detectCard(src); } catch (e) { corners = null; }
    let canvas;
    if (corners) {
      canvas = warp(src, corners);
    } else {
      canvas = drawFit(src, OUT_MAX).canvas;
    }
    relight(canvas);
    return { canvas, cropped: !!corners, corners };
  }

  root.CardEnhance = { enhance, detectCard };
})(self);
