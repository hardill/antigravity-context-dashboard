// 只读扫描本地 Desktop 与 CLI 的 brain/*/transcript.jsonl，生成每日热力图与来源统计。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const CACHE_TTL_MS = 15_000;
let cachedResult = null;
let cachedAt = 0;

function discoverSources() {
  const sources = [];
  const seen = new Set();

  const pushBrain = (label, rootDir) => {
    const brainDir = join(rootDir, 'brain');
    if (!existsSync(brainDir) || seen.has(brainDir.toLowerCase())) return;
    seen.add(brainDir.toLowerCase());
    sources.push({ label, brainDir });
  };

  // Sidecar 环境下优先定位当前宿主对应的 appData 目录
  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        pushBrain('Desktop', dirname(d));
        break;
      }
    }
  }

  const geminiRoot = join(homedir(), '.gemini');
  pushBrain('Desktop', join(geminiRoot, 'antigravity'));
  pushBrain('CLI', join(geminiRoot, 'antigravity-cli'));

  return sources;
}

function localDayKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildHeatmapGrid(dailyMap, days = 84) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const grid = [];
  let maxTokens = 0;

  for (let offset = days - 1; offset >= 0; offset--) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${day}`;
    const entry = dailyMap.get(key) || {
      date: key,
      freshInput: 0,
      cacheRead: 0,
      output: 0,
      totalTokens: 0,
      turns: 0,
    };
    if (entry.totalTokens > maxTokens) maxTokens = entry.totalTokens;
    grid.push(entry);
  }

  return { days: grid, maxTokens };
}

export function scanLocalTokenHistory({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const sources = discoverSources();
  const dailyMap = new Map();
  const bySource = {};
  const modelMap = new Map();

  let conversationsTotal = 0;
  let conversationsWithTokens = 0;
  let totalFreshInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalTurns = 0;

  for (const { label, brainDir } of sources) {
    const srcStats = {
      conversations: 0,
      conversationsWithTokens: 0,
      freshInput: 0,
      cacheRead: 0,
      output: 0,
      totalTokens: 0,
      turns: 0,
    };

    let convDirs = [];
    try {
      convDirs = readdirSync(brainDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }

    for (const dir of convDirs) {
      const logPath = join(brainDir, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(logPath)) continue;

      conversationsTotal++;
      srcStats.conversations++;

      let raw = '';
      try {
        const st = statSync(logPath);
        if (st.size === 0) continue;
        raw = readFileSync(logPath, 'utf8');
      } catch {
        continue;
      }

      let hasTok = false;
      let activeModelLabel = 'Unknown';
      const lines = raw.split('\n');

      for (const line of lines) {
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
          const m = /Model Selection`\s+from\s+.+?\s+to\s+(.+?)\./.exec(obj.content);
          if (m && m[1]) activeModelLabel = m[1].trim();
        }

        const fresh = Number(obj.input_tokens);
        const cache = Number(obj.cache_read_tokens);
        const out = Number(obj.output_tokens);
        const hasAny = Number.isFinite(fresh) || Number.isFinite(cache) || Number.isFinite(out);
        if (!hasAny) continue;

        hasTok = true;
        const f = Number.isFinite(fresh) ? fresh : 0;
        const c = Number.isFinite(cache) ? cache : 0;
        const o = Number.isFinite(out) ? out : 0;
        const all = f + c + o;

        totalFreshInput += f;
        totalCacheRead += c;
        totalOutput += o;
        totalTurns++;

        srcStats.freshInput += f;
        srcStats.cacheRead += c;
        srcStats.output += o;
        srcStats.totalTokens += all;
        srcStats.turns++;

        const day = localDayKey(obj.created_at);
        if (day) {
          const cur = dailyMap.get(day) || {
            date: day,
            freshInput: 0,
            cacheRead: 0,
            output: 0,
            totalTokens: 0,
            turns: 0,
          };
          cur.freshInput += f;
          cur.cacheRead += c;
          cur.output += o;
          cur.totalTokens += all;
          cur.turns++;
          dailyMap.set(day, cur);
        }

        const mEntry = modelMap.get(activeModelLabel) || {
          model: activeModelLabel,
          freshInput: 0,
          cacheRead: 0,
          output: 0,
          totalTokens: 0,
          turns: 0,
        };
        mEntry.freshInput += f;
        mEntry.cacheRead += c;
        mEntry.output += o;
        mEntry.totalTokens += all;
        mEntry.turns++;
        modelMap.set(activeModelLabel, mEntry);
      }

      if (hasTok) {
        conversationsWithTokens++;
        srcStats.conversationsWithTokens++;
      }
    }

    bySource[label] = srcStats;
  }

  const heatmap = buildHeatmapGrid(dailyMap, 84);
  const allPrompt = totalFreshInput + totalCacheRead;
  const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  cachedResult = {
    generatedAt: new Date().toISOString(),
    totals: {
      conversationsTotal,
      conversationsWithTokens,
      turns: totalTurns,
      freshInput: totalFreshInput,
      cacheRead: totalCacheRead,
      output: totalOutput,
      allTokens: totalFreshInput + totalCacheRead + totalOutput,
      cacheHitRate: allPrompt > 0 ? Number((totalCacheRead / allPrompt).toFixed(4)) : 0,
    },
    bySource,
    byModel,
    heatmap,
  };
  cachedAt = now;
  return cachedResult;
}
