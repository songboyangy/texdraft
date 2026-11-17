import { gunzipSync } from 'node:zlib';

/**
 * 轻量 SyncTeX 解析器：实现“源码行 → PDF 位置”和“PDF 点击 → 源码行”。
 * 坐标统一换算为 PDF big point（bp），原点在页面左上角，y 向下（与 pdf.js viewport 一致）。
 */

export interface Rect { x: number; y: number; w: number; h: number }

interface Rec {
  type: string; // [ ( h v x g k $
  page: number;
  tag: number;
  line: number;
  x: number;
  y: number; // 基线
  w: number;
  h: number; // 基线以上高度
  d: number; // 基线以下深度
}

export interface SynctexIndex {
  inputs: Map<number, string>; // tag -> 项目内路径（无法匹配的为 ''）
  records: Rec[];
}

const SP_PER_BP = 65781.76;

/**
 * @param projectPaths 用于把 synctex 中的绝对路径映射回项目路径（与执行器无关：本地目录或容器内 /work/src 都可）
 */
export function parseSynctex(gz: Buffer, projectPaths: string[]): SynctexIndex {
  const text = gunzipSync(gz).toString('utf8');
  const lines = text.split('\n');
  const inputs = new Map<number, string>();
  let unit = 1;
  let mag = 1000;
  let xOff = 0;
  let yOff = 0;
  let i = 0;

  const resolvePath = (raw: string) => {
    const p = raw.replace(/\\/g, '/').replace(/\/\.\//g, '/');
    let best = '';
    for (const cand of projectPaths) {
      for (const c of [cand, cand.replace(/\.tex$/, '')]) {
        if ((p === c || p.endsWith('/' + c)) && cand.length > best.length) best = cand;
      }
    }
    return best;
  };

  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('Content:')) { i++; break; }
    let m: RegExpExecArray | null;
    if ((m = /^Input:(\d+):(.*)$/.exec(l))) inputs.set(Number(m[1]), m[2] ? resolvePath(m[2]) : '');
    else if ((m = /^Unit:(-?\d+)/.exec(l))) unit = Number(m[1]);
    else if ((m = /^Magnification:(\d+)/.exec(l))) mag = Number(m[1]);
    else if ((m = /^X Offset:(-?\d+)/.exec(l))) xOff = Number(m[1]);
    else if ((m = /^Y Offset:(-?\d+)/.exec(l))) yOff = Number(m[1]);
  }

  const k = (unit * mag) / 1000 / SP_PER_BP;
  const cx = (v: number) => (v + xOff) * k;
  const cy = (v: number) => (v + yOff) * k;

  const records: Rec[] = [];
  let page = 0;
  // 形如  T tag,line(,col)?:x,y(:W(,H,D)?)?
  const RE = /^([[(hvxgk$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l[0];
    if (c === '{') { page = Number(l.slice(1)); continue; }
    if (c === 'I' && l.startsWith('Input:')) {
      // 内容中也可能出现新的 Input 声明
      const m = /^Input:(\d+):(.*)$/.exec(l);
      if (m) inputs.set(Number(m[1]), m[2] ? resolvePath(m[2]) : '');
      continue;
    }
    if (l.startsWith('Postamble')) break;
    const m = RE.exec(l);
    if (!m || page === 0) continue;
    const w = m[6] ? Number(m[6]) * k : 0;
    records.push({
      type: m[1],
      page,
      tag: Number(m[2]),
      line: Number(m[3]),
      x: cx(Number(m[4])),
      y: cy(Number(m[5])),
      w: m[1] === 'k' ? 0 : w, // kern 的宽度对定位无意义
      h: m[7] ? Number(m[7]) * k : 0,
      d: m[8] ? Number(m[8]) * k : 0,
    });
  }
  return { inputs, records };
}

const tagsFor = (idx: SynctexIndex, file: string) =>
  new Set([...idx.inputs].filter(([, p]) => p === file).map(([t]) => t));

/** 源码 → PDF：返回该行内容所在页与需要高亮的矩形 */
export function forwardSearch(idx: SynctexIndex, file: string, line: number) {
  const tags = tagsFor(idx, file);
  if (!tags.size) return null;
  const inFile = idx.records.filter((r) => tags.has(r.tag) && r.line > 0);
  if (!inFile.length) return null;
  // 精确行优先；没有则取之后最近的一行，再不行取之前最近的一行
  let target = line;
  if (!inFile.some((r) => r.line === line)) {
    const after = inFile.filter((r) => r.line > line).map((r) => r.line);
    const before = inFile.filter((r) => r.line < line).map((r) => r.line);
    target = after.length ? Math.min(...after) : Math.max(...before);
  }
  const hits = inFile.filter((r) => r.line === target);
  const page = Math.min(...hits.map((r) => r.page));
  const onPage = hits.filter((r) => r.page === page);
  // 用“同一行”的盒子/节点拼出高亮区域：按基线分组，每组取横向范围
  const byBaseline = new Map<number, Rec[]>();
  for (const r of onPage) {
    const key = Math.round(r.y * 2) / 2;
    if (!byBaseline.has(key)) byBaseline.set(key, []);
    byBaseline.get(key)!.push(r);
  }
  const pageBoxes = idx.records.filter((r) => r.page === page && r.type === '(' && r.w > 0);
  const rects: Rect[] = [];
  for (const group of byBaseline.values()) {
    const base = group[0].y;
    let x0 = Math.min(...group.map((r) => r.x));
    let x1 = Math.max(...group.map((r) => r.x + r.w));
    // 该行的节点（胶水、段首缩进等）往往只覆盖一部分；用包住它们的整行盒子补全横向范围
    const line = pageBoxes
      .filter((b) => Math.abs(b.y - base) < 0.5 && b.x <= x0 + 0.5 && b.x + b.w >= x0 - 0.5)
      .sort((a, b) => a.w - b.w)[0];
    if (line) {
      x0 = Math.max(line.x, Math.min(x0, line.x + line.w));
      x1 = Math.max(x1, line.x + line.w);
    }
    const h = Math.max(8, line?.h ?? 0, ...group.map((r) => r.h));
    const d = Math.max(2, line?.d ?? 0, ...group.map((r) => r.d));
    rects.push({ x: x0, y: base - h, w: Math.max(x1 - x0, 20), h: h + d });
  }
  rects.sort((a, b) => a.y - b.y);
  return { page, line: target, rects: rects.slice(0, 12) };
}

/** PDF → 源码：给定页面上的点（bp），返回最可能的源文件与行号 */
export function reverseSearch(idx: SynctexIndex, page: number, x: number, y: number) {
  const recs = idx.records.filter((r) => r.page === page && idx.inputs.get(r.tag));
  if (!recs.length) return null;

  // 1) 包含该点的最小水平盒子
  const boxes = recs.filter(
    (r) => (r.type === '(' || r.type === 'h') && x >= r.x && x <= r.x + r.w && y >= r.y - r.h - 1 && y <= r.y + r.d + 1,
  );
  boxes.sort((a, b) => a.w * (a.h + a.d) - b.w * (b.h + b.d));
  const box = boxes[0];

  // 2) 在该盒子的基线上找横坐标最接近（且不超过）点击位置的节点，行号更精确
  let best: Rec | undefined;
  if (box) {
    const sameLine = recs.filter((r) => Math.abs(r.y - box.y) < 0.5 && r.x >= box.x - 0.5 && r.x <= box.x + box.w + 0.5);
    const left = sameLine.filter((r) => r.x <= x).sort((a, b) => b.x - a.x);
    best = left[0] ?? sameLine.sort((a, b) => a.x - b.x)[0] ?? box;
  } else {
    // 3) 兜底：距离最近的记录
    let bestD = Infinity;
    for (const r of recs) {
      const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
      const dy = y < r.y - r.h ? r.y - r.h - y : y > r.y + r.d ? y - r.y - r.d : 0;
      const dist = dx * dx + dy * dy * 4; // 纵向距离权重更高
      if (dist < bestD) { bestD = dist; best = r; }
    }
  }
  if (!best) return null;
  return { file: idx.inputs.get(best.tag)!, line: best.line };
}

// ---- 解析结果缓存（按编译任务） ----
const cache = new Map<string, SynctexIndex>();
export function cachedIndex(jobId: string, build: () => SynctexIndex): SynctexIndex {
  let v = cache.get(jobId);
  if (!v) {
    v = build();
    cache.set(jobId, v);
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
  }
  return v;
}
