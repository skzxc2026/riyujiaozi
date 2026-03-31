#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const HTML_PATH = path.join(ROOT, '首页.html');
const PATCH_PATH = path.join(ROOT, 'lesson_override_patches.js');

function getArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return String(process.argv[idx + 1]);
  }
  return fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractScriptBlock(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('未找到内联 <script> 代码');
  return m[1];
}

function extractObjectLiteralAfter(source, marker) {
  const startMarker = source.indexOf(marker);
  if (startMarker < 0) throw new Error(`未找到 marker: ${marker}`);

  let i = source.indexOf('{', startMarker);
  if (i < 0) throw new Error(`marker 后未找到对象起始 { : ${marker}`);

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;

  for (let p = i; p < source.length; p++) {
    const ch = source[p];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      if (inSingle || inDouble || inBacktick) {
        escaped = true;
      }
      continue;
    }

    if (!inDouble && !inBacktick && ch === '\'' ) {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingle || inDouble || inBacktick) continue;

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(i, p + 1);
      }
    }
  }

  throw new Error(`对象未闭合: ${marker}`);
}

function evalObjectLiteral(objectLiteral) {
  return vm.runInNewContext(`(${objectLiteral})`, Object.create(null), { timeout: 10_000 });
}

function normalizeMarker(line) {
  return String(line || '').replace(/[：:]/g, '').trim();
}

const STRUCT_MARKERS = new Set(['導入', 'プレゼンテーション', '練習', '応用', 'まとめと宿題']);

function parseScriptLines(scriptRaw, skipIntroLine) {
  const out = [];
  for (const raw of scriptRaw || []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (STRUCT_MARKERS.has(normalizeMarker(t))) continue;
    if (skipIntroLine && /^各位考官好/.test(t)) continue;
    out.push(t);
  }
  return out;
}

function splitTextForPlayback(text) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const matched = src.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [src];
  const out = [];
  for (const raw of matched) {
    const speak = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!speak) continue;
    if (!/[A-Za-z0-9ぁ-んァ-ン一-龯]/.test(speak)) {
      if (out.length > 0) {
        out[out.length - 1].raw += raw;
        out[out.length - 1].speak += speak;
      }
      continue;
    }
    out.push({ raw, speak });
  }
  return out.length ? out : [{ raw: src, speak: src.trim() }];
}

async function synthOne(proxyBase, apiKey, payload) {
  const url = `${proxyBase.replace(/\/+$/, '')}/v1/minimax/speech`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Minimax-Key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`HTTP_${res.status}: ${errText}`);
  }
  const arrBuf = await res.arrayBuffer();
  return Buffer.from(arrBuf);
}

function isRateLimitError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('rate limit') || m.includes('rpm') || m.includes('1002');
}

async function synthWithRetry(proxyBase, apiKey, payload, retries = 8) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await synthOne(proxyBase, apiKey, payload);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e || '');
      const baseWait = 1200 * (i + 1);
      const waitMs = isRateLimitError(msg) ? Math.max(30_000, baseWait) : baseWait;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function loadOverrides() {
  const html = readText(HTML_PATH);
  const script = extractScriptBlock(html);

  const lessonOverridesObj = evalObjectLiteral(
    extractObjectLiteralAfter(script, 'const LESSON_OVERRIDES =')
  );
  const lessonWordOverridesObj = evalObjectLiteral(
    extractObjectLiteralAfter(script, 'const LESSON_WORD_OVERRIDES =')
  );

  const merged = { ...lessonOverridesObj, ...lessonWordOverridesObj };

  if (fs.existsSync(PATCH_PATH)) {
    const patchSrc = readText(PATCH_PATH);
    try {
      const patchObj = evalObjectLiteral(
        extractObjectLiteralAfter(patchSrc, 'window.LESSON_OVERRIDE_PATCHES =')
      );
      Object.keys(patchObj || {}).forEach((k) => {
        merged[k] = patchObj[k] || {};
      });
    } catch (_) {
      // ignore patch parse errors
    }
  }

  return merged;
}

async function main() {
  const fromLesson = Number(getArg('--from', '25'));
  const toLesson = Number(getArg('--to', '48'));
  const proxyBase = getArg('--proxy', 'http://127.0.0.1:8787');
  const outputRoot = getArg('--out', path.join(ROOT, 'minimax_tts_25_48'));
  const model = getArg('--model', 'speech-2.6-hd');
  const voiceId = getArg('--voice-id', 'Japanese_KindLady');
  const groupId = getArg('--group-id', '');
  const speed = Number(getArg('--speed', '1'));
  const vol = Number(getArg('--vol', '1'));
  const pitch = Number(getArg('--pitch', '0'));
  const delayMs = Math.max(0, Number(getArg('--delay-ms', '3500')) || 0);
  const skipIntroLine = !hasArg('--keep-intro');
  const dryRun = hasArg('--dry-run');
  const force = hasArg('--force');
  const continueOnError = !hasArg('--stop-on-error');

  const apiKey = getArg('--api-key', process.env.MINIMAX_API_KEY || '');
  if (!dryRun && !apiKey) {
    throw new Error('缺少 MiniMax API Key。请通过 --api-key 或环境变量 MINIMAX_API_KEY 提供。');
  }

  const overrides = loadOverrides();
  ensureDir(outputRoot);

  const manifest = {
    generatedAt: new Date().toISOString(),
    fromLesson,
    toLesson,
    model,
    voiceId,
    groupId,
    speed,
    vol,
    pitch,
    delayMs,
    lessons: {}
  };
  manifest.failures = [];

  let totalSegments = 0;

  for (let lesson = fromLesson; lesson <= toLesson; lesson++) {
    const key = String(lesson);
    const cfg = overrides[key];
    if (!cfg || !Array.isArray(cfg.scriptRaw)) {
      console.log(`[WARN] 第${lesson}课未找到 scriptRaw，跳过`);
      continue;
    }

    const lines = parseScriptLines(cfg.scriptRaw, skipIntroLine);
    const lessonDir = path.join(outputRoot, `第${lesson}课`);
    ensureDir(lessonDir);

    manifest.lessons[key] = {
      lineCount: lines.length,
      lines: []
    };

    let lessonSegCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const lineText = lines[i];
      const segs = splitTextForPlayback(lineText);
      const lineMeta = {
        lineNo,
        text: lineText,
        segments: []
      };

      for (let j = 0; j < segs.length; j++) {
        const segNo = j + 1;
        const seg = segs[j];
        const fileName = `${String(lineNo).padStart(3, '0')}_${String(segNo).padStart(2, '0')}.mp3`;
        const filePath = path.join(lessonDir, fileName);

        lineMeta.segments.push({
          segNo,
          text: seg.speak,
          file: fileName
        });

        if (dryRun) continue;
        if (!force && fs.existsSync(filePath)) {
          continue;
        }

        const payload = {
          input: seg.speak,
          model,
          voice_id: voiceId,
          speed,
          vol,
          pitch,
          format: 'mp3'
        };
        if (groupId) payload.group_id = groupId;

        try {
          const audio = await synthWithRetry(proxyBase, apiKey, payload, 8);
          fs.writeFileSync(filePath, audio);
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        } catch (e) {
          const em = String((e && e.message) || e || 'unknown_error');
          manifest.failures.push({
            lesson,
            lineNo,
            segNo,
            text: seg.speak,
            error: em
          });
          console.log(`[FAIL] 第${lesson}课 第${lineNo}行-${segNo}段: ${em.slice(0, 180)}`);
          if (!continueOnError) throw e;
        }
      }

      lessonSegCount += segs.length;
      manifest.lessons[key].lines.push(lineMeta);
    }

    totalSegments += lessonSegCount;
    console.log(`[OK] 第${lesson}课: ${lines.length}行, ${lessonSegCount}段`);
  }

  const manifestPath = path.join(outputRoot, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n完成: ${dryRun ? 'Dry run' : '已导出'}，总分段 ${totalSegments}，失败 ${manifest.failures.length}`);
  console.log(`输出目录: ${outputRoot}`);
  console.log(`索引文件: ${manifestPath}`);
}

main().catch((err) => {
  console.error('[ERROR]', err && err.message ? err.message : err);
  process.exit(1);
});
