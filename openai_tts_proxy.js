#!/usr/bin/env node
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 8787);
const OPENAI_BASE_URL_DEFAULT = 'https://api.openai.com';
const MINIMAX_BASE_URL_DEFAULT = 'https://api.minimaxi.com';
const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-OpenAI-Key, X-OpenAI-Base-URL, X-TTSMaker-Token, X-Minimax-Key, X-Minimax-Group-Id, X-Minimax-Base-URL, Authorization'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeOpenAIBaseUrl(raw) {
  const src = String(raw || '').trim();
  if (!src) return OPENAI_BASE_URL_DEFAULT;
  const noSlash = src.replace(/\/+$/, '');
  const noV1 = noSlash.endsWith('/v1') ? noSlash.slice(0, -3) : noSlash;
  if (!/^https?:\/\//i.test(noV1)) return OPENAI_BASE_URL_DEFAULT;
  return noV1;
}

function normalizeMiniMaxBaseUrl(raw) {
  const src = String(raw || '').trim();
  if (!src) return MINIMAX_BASE_URL_DEFAULT;
  const noSlash = src.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(noSlash)) return MINIMAX_BASE_URL_DEFAULT;
  return noSlash;
}

function normalizeCompatibleBaseUrl(raw) {
  const src = String(raw || '').trim();
  if (!src) return '';
  const noSlash = src.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(noSlash)) return '';
  return noSlash;
}

function resolveCompatiblePreset(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  const presets = {
    qwen: {
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-tts-latest',
      voice: 'Cherry',
      supported: true
    },
    deepseek: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      voice: 'alloy',
      supported: false,
      reason: 'deepseek_no_official_tts_endpoint'
    },
    doubao: {
      provider: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-tts',
      voice: 'zh_female_wanwanxiaohe_moon_bigtts',
      supported: true
    },
    custom: {
      provider: 'custom',
      baseUrl: '',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      supported: true
    }
  };
  return presets[provider] || presets.custom;
}

function buildCompatibleSpeechUrl(baseUrl) {
  const base = normalizeCompatibleBaseUrl(baseUrl);
  if (!base) return '';
  if (/\/audio\/speech$/i.test(base)) return base;
  return `${base}/audio/speech`;
}

function resolveOpenAIBaseUrl(req, body) {
  return normalizeOpenAIBaseUrl(
    req.headers['x-openai-base-url'] ||
    body.baseUrl ||
    process.env.OPENAI_BASE_URL ||
    OPENAI_BASE_URL_DEFAULT
  );
}

async function handleTTS(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'Bad request' });
  }

  const apiKey = String(req.headers['x-openai-key'] || body.apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 400, { error: 'Missing API key. Provide X-OpenAI-Key header or OPENAI_API_KEY env.' });
  }

  const payload = {
    model: body.model || 'gpt-4o-mini-tts',
    voice: body.voice || 'alloy',
    format: body.format || 'mp3',
    input: body.input || ''
  };
  if (body.instructions) payload.instructions = body.instructions;

  if (!payload.input || !String(payload.input).trim()) {
    return sendJson(res, 400, { error: 'Missing input text' });
  }
  const openaiBaseUrl = resolveOpenAIBaseUrl(req, body);
  const openaiTtsUrl = `${openaiBaseUrl}/v1/audio/speech`;

  try {
    const upstream = await fetch(openaiTtsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    setCors(res);
    res.statusCode = upstream.status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (e) {
    const causeCode = e && e.cause && e.cause.code ? e.cause.code : '';
    const causeMsg = e && e.cause && e.cause.message ? e.cause.message : '';
    const msg = [e && e.message ? e.message : String(e), causeCode, causeMsg].filter(Boolean).join(' | ');
    sendJson(res, 502, { error: `Proxy request failed: ${msg}` });
  }
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'Bad request' });
  }

  const apiKey = String(req.headers['x-openai-key'] || body.apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 400, { error: 'Missing API key. Provide X-OpenAI-Key header or OPENAI_API_KEY env.' });
  }

  const payload = {
    model: body.model || 'gpt-4o-mini',
    messages: Array.isArray(body.messages) ? body.messages : [],
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.2
  };
  if (body.response_format) payload.response_format = body.response_format;
  if (!payload.messages.length) {
    return sendJson(res, 400, { error: 'Missing messages for chat completions' });
  }
  const openaiBaseUrl = resolveOpenAIBaseUrl(req, body);
  const openaiChatUrl = `${openaiBaseUrl}/v1/chat/completions`;

  try {
    const upstream = await fetch(openaiChatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    setCors(res);
    res.statusCode = upstream.status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (e) {
    const causeCode = e && e.cause && e.cause.code ? e.cause.code : '';
    const causeMsg = e && e.cause && e.cause.message ? e.cause.message : '';
    const msg = [e && e.message ? e.message : String(e), causeCode, causeMsg].filter(Boolean).join(' | ');
    sendJson(res, 502, { error: `Proxy request failed: ${msg}` });
  }
}

async function handleModels(req, res) {
  const apiKey = String(req.headers['x-openai-key'] || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 400, { error: 'Missing API key. Provide X-OpenAI-Key header or OPENAI_API_KEY env.' });
  }
  const openaiBaseUrl = normalizeOpenAIBaseUrl(req.headers['x-openai-base-url'] || process.env.OPENAI_BASE_URL || OPENAI_BASE_URL_DEFAULT);
  const modelsUrl = `${openaiBaseUrl}/v1/models`;

  try {
    const upstream = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    setCors(res);
    res.statusCode = upstream.status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (e) {
    const causeCode = e && e.cause && e.cause.code ? e.cause.code : '';
    const causeMsg = e && e.cause && e.cause.message ? e.cause.message : '';
    const msg = [e && e.message ? e.message : String(e), causeCode, causeMsg].filter(Boolean).join(' | ');
    sendJson(res, 502, { error: `Proxy request failed: ${msg}` });
  }
}

async function translateViaGoogle(text, source = 'ja', target = 'zh-CN') {
  const q = String(text || '').trim();
  if (!q) return '';
  const params = new URLSearchParams({
    client: 'gtx',
    sl: source,
    tl: target,
    dt: 't',
    q
  });
  const url = `${GOOGLE_TRANSLATE_URL}?${params.toString()}`;
  const upstream = await fetch(url, { method: 'GET' });
  if (!upstream.ok) {
    const t = (await upstream.text().catch(() => '')).slice(0, 300);
    throw new Error(`google_http_${upstream.status}:${t}`);
  }
  const data = await upstream.json();
  const arr = Array.isArray(data) ? data[0] : [];
  if (!Array.isArray(arr)) return '';
  return arr.map((x) => (Array.isArray(x) ? (x[0] || '') : '')).join('').trim();
}

async function handleTranslate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'Bad request' });
  }

  const source = String(body.source || 'ja').trim() || 'ja';
  const target = String(body.target || 'zh-CN').trim() || 'zh-CN';
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return sendJson(res, 400, { error: 'Missing items' });

  const out = {};
  const errors = [];
  for (const it of items) {
    const id = String((it && it.id) || '').trim();
    const text = String((it && it.text) || '').trim();
    if (!id || !text) continue;
    try {
      const zh = await translateViaGoogle(text, source, target);
      if (zh) out[id] = zh;
      else errors.push({ id, error: 'empty_translation' });
    } catch (e) {
      errors.push({ id, error: String((e && e.message) || e || 'translate_failed') });
    }
  }
  return sendJson(res, 200, { ok: true, provider: 'google', translations: out, errors });
}

async function handleTTSMakerSpeech(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'Bad request' });
  }

  const token = String(req.headers['x-ttsmaker-token'] || body.token || process.env.TTSMAKER_TOKEN || '').trim();
  const input = String(body.input || body.text || '').trim();
  const voiceId = String(body.voice_id || body.voiceId || process.env.TTSMAKER_VOICE_ID || '').trim();
  const format = String(body.format || body.audio_format || 'mp3').trim() || 'mp3';
  const speedNum = Number(body.audio_speed || body.speed || 1);
  const speed = Number.isFinite(speedNum) ? Math.max(0.5, Math.min(2.0, speedNum)) : 1;

  if (!token) return sendJson(res, 400, { error: 'Missing TTSMaker token. Provide token or TTSMAKER_TOKEN env.' });
  if (!input) return sendJson(res, 400, { error: 'Missing input text' });
  if (!voiceId) return sendJson(res, 400, { error: 'Missing voice_id. Provide voice_id or TTSMAKER_VOICE_ID env.' });

  const createUrl = 'https://api.ttsmaker.cn/v1/create-tts-order';
  const payload = {
    token,
    text: input,
    voice_id: voiceId,
    audio_format: format,
    audio_speed: speed,
    text_paragraph_pause_time: 0
  };

  try {
    const up = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await up.text();
    let data = {};
    try { data = JSON.parse(txt); } catch (_) {}
    if (!up.ok) {
      return sendJson(res, 502, { error: `TTSMAKER_HTTP_${up.status}:${txt.slice(0, 300)}` });
    }
    const errorCode = Number(data.error_code || data.code || 0);
    if (errorCode !== 0) {
      const msg = String(data.error_details || data.message || data.msg || 'ttsmaker_error');
      return sendJson(res, 502, { error: `TTSMAKER_API_${errorCode}:${msg}` });
    }
    const audioUrl =
      String(
        data.audio_file_url ||
        data.audio_url ||
        ((data.data && (data.data.audio_file_url || data.data.audio_url)) || '')
      ).trim();
    if (!audioUrl) {
      return sendJson(res, 502, { error: `TTSMAKER_NO_AUDIO_URL:${txt.slice(0, 300)}` });
    }

    const audioRes = await fetch(audioUrl, { method: 'GET' });
    if (!audioRes.ok) {
      const eTxt = (await audioRes.text().catch(() => '')).slice(0, 300);
      return sendJson(res, 502, { error: `TTSMAKER_AUDIO_HTTP_${audioRes.status}:${eTxt}` });
    }
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    setCors(res);
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', audioRes.headers.get('content-type') || 'audio/mpeg');
    return res.end(buffer);
  } catch (e) {
    const causeCode = e && e.cause && e.cause.code ? e.cause.code : '';
    const causeMsg = e && e.cause && e.cause.message ? e.cause.message : '';
    const msg = [e && e.message ? e.message : String(e), causeCode, causeMsg].filter(Boolean).join(' | ');
    return sendJson(res, 502, { error: `TTSMAKER_PROXY_FAILED:${msg}` });
  }
}

function decodeAudioDataToBuffer(audioDataRaw) {
  const raw = String(audioDataRaw || '').trim();
  if (!raw) return null;

  const dataUriMatch = raw.match(/^data:audio\/[^;]+;base64,(.+)$/i);
  if (dataUriMatch && dataUriMatch[1]) {
    return Buffer.from(dataUriMatch[1], 'base64');
  }

  const cleaned = raw.replace(/^0x/i, '').replace(/\s+/g, '');
  const isHex = /^[\da-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0;
  if (isHex) return Buffer.from(cleaned, 'hex');

  // Fallback: some providers may return base64 without a data URI prefix.
  try {
    return Buffer.from(raw, 'base64');
  } catch (_) {
    return null;
  }
}

async function handleMiniMaxSpeech(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message || 'Bad request' });
  }

  const apiKey = String(
    req.headers['x-minimax-key'] ||
    body.apiKey ||
    body.key ||
    body.token ||
    process.env.MINIMAX_API_KEY ||
    ''
  ).trim();
  const groupId = String(
    req.headers['x-minimax-group-id'] ||
    body.groupId ||
    body.group_id ||
    process.env.MINIMAX_GROUP_ID ||
    ''
  ).trim();
  const baseUrl = normalizeMiniMaxBaseUrl(
    req.headers['x-minimax-base-url'] ||
    body.baseUrl ||
    process.env.MINIMAX_BASE_URL ||
    MINIMAX_BASE_URL_DEFAULT
  );

  const input = String(body.input || body.text || '').trim();
  const model = String(body.model || process.env.MINIMAX_SPEECH_MODEL || 'speech-2.6-hd').trim();
  const voiceId = String(body.voice_id || body.voiceId || process.env.MINIMAX_VOICE_ID || '').trim();
  const speedRaw = Number(body.speed);
  const speed = Number.isFinite(speedRaw) ? Math.max(0.5, Math.min(2, speedRaw)) : 1;
  const volRaw = Number(body.vol);
  const vol = Number.isFinite(volRaw) ? Math.max(0.1, Math.min(10, volRaw)) : 1;
  const pitchRaw = Number(body.pitch);
  const pitch = Number.isFinite(pitchRaw) ? Math.max(-20, Math.min(20, pitchRaw)) : 0;
  const format = String(body.format || 'mp3').trim().toLowerCase();
  const sampleRateRaw = Number(body.sample_rate);
  const sampleRate = Number.isFinite(sampleRateRaw) ? sampleRateRaw : 32000;
  const bitrateRaw = Number(body.bitrate);
  const bitrate = Number.isFinite(bitrateRaw) ? bitrateRaw : 128000;

  if (!apiKey) return sendJson(res, 400, { error: 'Missing MiniMax API key. Provide X-Minimax-Key header or MINIMAX_API_KEY env.' });
  if (!input) return sendJson(res, 400, { error: 'Missing input text' });
  if (!voiceId) return sendJson(res, 400, { error: 'Missing voice_id. Provide voice_id or MINIMAX_VOICE_ID env.' });

  const payload = {
    model,
    text: input,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed,
      vol,
      pitch
    },
    audio_setting: {
      sample_rate: sampleRate,
      bitrate,
      format,
      channel: 1
    },
    subtitle_enable: false
  };

  let t2aUrl = `${baseUrl}/v1/t2a_v2`;
  if (groupId) {
    t2aUrl += `?GroupId=${encodeURIComponent(groupId)}`;
  }

  try {
    const upstream = await fetch(t2aUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const txt = await upstream.text();
    let data = {};
    try { data = JSON.parse(txt); } catch (_) {}

    if (!upstream.ok) {
      return sendJson(res, 502, { error: `MINIMAX_HTTP_${upstream.status}:${txt.slice(0, 300)}` });
    }

    const statusCode = Number(data && data.base_resp && data.base_resp.status_code);
    if (!Number.isNaN(statusCode) && statusCode !== 0) {
      const msg = String((data && data.base_resp && data.base_resp.status_msg) || 'minimax_error');
      return sendJson(res, 502, { error: `MINIMAX_API_${statusCode}:${msg}` });
    }

    const audioData =
      (data && data.data && data.data.audio) ||
      data.audio ||
      '';
    const buffer = decodeAudioDataToBuffer(audioData);
    if (!buffer || !buffer.length) {
      return sendJson(res, 502, { error: `MINIMAX_NO_AUDIO:${txt.slice(0, 300)}` });
    }

    const contentTypeMap = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      flac: 'audio/flac',
      pcm: 'audio/pcm'
    };
    setCors(res);
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', contentTypeMap[format] || 'application/octet-stream');
    return res.end(buffer);
  } catch (e) {
    const causeCode = e && e.cause && e.cause.code ? e.cause.code : '';
    const causeMsg = e && e.cause && e.cause.message ? e.cause.message : '';
    const msg = [e && e.message ? e.message : String(e), causeCode, causeMsg].filter(Boolean).join(' | ');
    return sendJson(res, 502, { error: `MINIMAX_PROXY_FAILED:${msg}` });
  }
}

async function handleCompatibleCheck(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message || 'Bad request' });
  }

  const provider = String(body.provider || 'custom').trim().toLowerCase();
  const preset = resolveCompatiblePreset(provider);
  if (!preset.supported) {
    return sendJson(res, 200, {
      ok: false,
      provider: preset.provider,
      supported: false,
      reason: preset.reason || 'provider_not_supported'
    });
  }

  const apiKey = String(body.apiKey || req.headers['x-openai-key'] || '').trim();
  if (!apiKey) {
    return sendJson(res, 400, { ok: false, provider: preset.provider, error: 'missing_api_key' });
  }

  const baseUrl = normalizeCompatibleBaseUrl(body.baseUrl || preset.baseUrl || '');
  const endpoint = buildCompatibleSpeechUrl(baseUrl);
  if (!endpoint) {
    return sendJson(res, 400, { ok: false, provider: preset.provider, error: 'missing_or_invalid_base_url' });
  }

  const model = String(body.model || preset.model || '').trim() || 'gpt-4o-mini-tts';
  const voice = String(body.voice || preset.voice || '').trim() || 'alloy';
  const input = String(body.input || 'こんにちは。テストです。').trim();
  const payload = {
    model,
    voice,
    format: String(body.format || 'mp3').trim() || 'mp3',
    input
  };

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    if (!upstream.ok) {
      const txt = (await upstream.text().catch(() => '')).slice(0, 300);
      return sendJson(res, 200, {
        ok: false,
        provider: preset.provider,
        endpoint,
        status: upstream.status,
        error: `UPSTREAM_HTTP_${upstream.status}:${txt}`
      });
    }
    const ctype = String(upstream.headers.get('content-type') || '').toLowerCase();
    const size = Number(upstream.headers.get('content-length') || 0) || 0;
    if (ctype.includes('application/json')) {
      const txt = (await upstream.text().catch(() => '')).slice(0, 300);
      return sendJson(res, 200, {
        ok: false,
        provider: preset.provider,
        endpoint,
        status: upstream.status,
        error: `UPSTREAM_JSON_RESPONSE:${txt}`
      });
    }
    // Consume body to ensure provider truly returned audio data.
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return sendJson(res, 200, {
      ok: true,
      provider: preset.provider,
      endpoint,
      message: 'tts_api_reachable',
      contentType: ctype || 'application/octet-stream',
      bytes: size || buffer.length
    });
  } catch (e) {
    const causeCode = e && e.cause && e.cause.code ? e.cause.code : '';
    const causeMsg = e && e.cause && e.cause.message ? e.cause.message : '';
    const msg = [e && e.message ? e.message : String(e), causeCode, causeMsg].filter(Boolean).join(' | ');
    return sendJson(res, 502, { ok: false, provider: preset.provider, endpoint, error: `COMPATIBLE_CHECK_FAILED:${msg}` });
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'openai-tts-proxy',
      hasEnvOpenAIKey: !!String(process.env.OPENAI_API_KEY || '').trim(),
      hasEnvTTSMakerToken: !!String(process.env.TTSMAKER_TOKEN || '').trim(),
      hasEnvMiniMaxKey: !!String(process.env.MINIMAX_API_KEY || '').trim(),
      hasEnvMiniMaxGroupId: !!String(process.env.MINIMAX_GROUP_ID || '').trim(),
      minimaxBaseUrlDefault: normalizeMiniMaxBaseUrl(process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL_DEFAULT),
      openaiBaseUrlDefault: normalizeOpenAIBaseUrl(process.env.OPENAI_BASE_URL || OPENAI_BASE_URL_DEFAULT)
    });
  }

  if (req.method === 'POST' && req.url === '/v1/audio/speech') {
    return handleTTS(req, res);
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    return handleChatCompletions(req, res);
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return handleModels(req, res);
  }
  if (req.method === 'POST' && req.url === '/v1/translate') {
    return handleTranslate(req, res);
  }
  if (req.method === 'POST' && req.url === '/v1/ttsmaker/speech') {
    return handleTTSMakerSpeech(req, res);
  }
  if (req.method === 'POST' && req.url === '/v1/minimax/speech') {
    return handleMiniMaxSpeech(req, res);
  }
  if (req.method === 'POST' && req.url === '/v1/compatible/check') {
    return handleCompatibleCheck(req, res);
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[openai-tts-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log('[openai-tts-proxy] endpoints: GET /health, GET /v1/models, POST /v1/audio/speech, POST /v1/chat/completions, POST /v1/translate, POST /v1/ttsmaker/speech, POST /v1/minimax/speech, POST /v1/compatible/check');
});
