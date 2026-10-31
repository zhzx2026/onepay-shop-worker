// Public-share adapters. These endpoints are unofficial and may be blocked or
// change without notice. Never fetch a user-supplied URL or follow redirects.
export const MAX_PREVIEW_FILES = 150;
const PAGE_SIZE = 100;
const MAX_LIST_CALLS = 6;
const MAX_DEPTH = 2; // root and one child level
const MAX_JSON_BYTES = 1024 * 1024;

export function detectNetdisk(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,100})\/?$/);
    if (!match) return null;
    if (url.hostname === 'pan.quark.cn') return { id: 'quark', label: '夸克网盘', shareId: match[1], password: url.searchParams.get('pwd') || '' };
    if (url.hostname === 'pan.baidu.com' && /^1[A-Za-z0-9_-]+$/.test(match[1])) {
      return { id: 'baidu', label: '百度网盘', shareId: match[1].slice(1), password: url.searchParams.get('pwd') || '' };
    }
  } catch { /* Invalid URLs are not recognized. */ }
  return null;
}

export function providerTags(tags, type, url, max = 8) {
  const provider = type === 'LINK' ? detectNetdisk(url) : null;
  const clean = (Array.isArray(tags) ? tags : []).filter(tag => tag !== '夸克网盘' && tag !== '百度网盘');
  if (provider) clean.unshift(provider.label);
  return clean.slice(0, max);
}

function looksPrivate(text) {
  return /https?:\/\/|(?:pan\.(?:quark\.cn|baidu\.com))|(?:提取码|访问码|访问密码|分享密码)/i.test(text);
}

// The preview is intentionally only a list of names, not links, IDs or tokens.
export function normalizePreview(input) {
  let lines;
  if (Array.isArray(input)) lines = input.map(x => typeof x === 'string' ? x : String(x?.path || ''));
  else lines = String(input ?? '').split(/\r?\n/);
  lines = lines.map(line => line.trim()).filter(Boolean);
  if (lines.length > MAX_PREVIEW_FILES) return { ok: false, error: `目录最多 ${MAX_PREVIEW_FILES} 项` };
  const seen = new Set();
  const items = [];
  for (const line of lines) {
    if (line.length > 240 || /[\u0000-\u001f\u007f]/.test(line) || looksPrivate(line)) {
      return { ok: false, error: '目录只能填写文件或文件夹名称（每项不超过 240 字），请勿包含链接或提取码' };
    }
    if (!seen.has(line)) { seen.add(line); items.push(line); }
  }
  return { ok: true, items };
}

function safeName(value) {
  const name = String(value || '').trim().replace(/[\u0000-\u001f\u007f/\\]/g, ' ');
  if (!name || looksPrivate(name)) return '';
  return name.slice(0, 120);
}

async function requestJson(url, options, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('unavailable');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return { data: JSON.parse(new TextDecoder().decode(bytes)), headers: response.headers };
  } finally { clearTimeout(timer); }
}

function providerError() {
  // Don't copy upstream messages: they can contain URLs, passcodes or tokens.
  return new Error('网盘暂时无法公开读取，可能需要提取码、登录或受到风控限制；请检查后重试，或手动填写目录。');
}

export async function readShareDirectory(value, passcode = '', fetcher = fetch) {
  const provider = detectNetdisk(value);
  if (!provider) throw new Error('仅支持 https://pan.quark.cn/s/… 或 https://pan.baidu.com/s/1… 分享链接，请手动填写其他目录。');
  const pwd = String(passcode || provider.password || '').trim();
  if (pwd && !/^[A-Za-z0-9]{1,16}$/.test(pwd)) throw new Error('提取码格式无效，请填写 1–16 位字母或数字。');
  try {
    return provider.id === 'quark'
      ? await quarkDirectory(provider, pwd, fetcher)
      : await baiduDirectory(provider, pwd, fetcher);
  } catch (error) {
    // Only our own, static error is exposed to the admin UI.
    throw providerError();
  }
}

async function collectDirectory(provider, initial, list, makeChild) {
  const queue = [{ ref: initial, prefix: '', depth: 0, page: 1 }];
  const seen = new Set(); const items = [];
  let calls = 0, truncated = false;
  while (queue.length && calls < MAX_LIST_CALLS && items.length < MAX_PREVIEW_FILES) {
    const current = queue.shift();
    let entries;
    try { entries = await list(current); calls++; }
    catch (error) {
      if (!calls) throw error;
      truncated = true; break;
    }
    if (!Array.isArray(entries)) throw new Error('invalid list');
    for (const entry of entries) {
      const name = safeName(entry.name);
      if (!name) { truncated = true; continue; }
      const path = `${current.prefix}${name}${entry.directory ? '/' : ''}`;
      if (path.length > 240) { truncated = true; continue; }
      if (!seen.has(path)) { seen.add(path); items.push(path); }
      if (entry.directory) {
        if (current.depth + 1 < MAX_DEPTH) {
          const ref = makeChild(entry);
          if (ref) queue.push({ ref, prefix: path, depth: current.depth + 1, page: 1 });
          else truncated = true;
        } else truncated = true;
      }
      if (items.length >= MAX_PREVIEW_FILES) { truncated = true; break; }
    }
    if (entries.length >= PAGE_SIZE) queue.push({ ...current, page: current.page + 1 });
  }
  if (queue.length) truncated = true;
  return { provider: { id: provider.id, label: provider.label }, items, truncated };
}

async function quarkDirectory(provider, passcode, fetcher) {
  const base = 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/';
  const query = { pr: 'ucpro', fr: 'pc', uc_param_str: '' };
  const headers = { 'accept': 'application/json', 'origin': 'https://pan.quark.cn', 'referer': 'https://pan.quark.cn/' };
  const tokenUrl = new URL(base + 'token');
  for (const [key, value] of Object.entries(query)) tokenUrl.searchParams.set(key, value);
  const token = await requestJson(tokenUrl.toString(), {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ pwd_id: provider.shareId, passcode, support_visit_limit_private_share: true }),
  }, fetcher);
  const stoken = token.data?.data?.stoken;
  if (typeof stoken !== 'string' || !stoken || stoken.length > 1024) throw new Error('token unavailable');
  return collectDirectory(provider, '0', async current => {
    const url = new URL(base + 'detail');
    for (const [key, value] of Object.entries({ ...query, pwd_id: provider.shareId, stoken, pdir_fid: current.ref, force: '0', _page: String(current.page), _size: String(PAGE_SIZE), _fetch_total: '1', _sort: 'file_type:asc,updated_at:desc' })) url.searchParams.set(key, value);
    const response = await requestJson(url.toString(), { headers }, fetcher);
    const list = response.data?.data?.list;
    if (!Array.isArray(list)) throw new Error('invalid list');
    return list.map(item => ({ name: item.file_name, directory: item.dir === true || item.dir === 1 || item.file_type === 0, ref: item.fid }));
  }, entry => /^[A-Za-z0-9_-]{1,128}$/.test(String(entry.ref || '')) ? entry.ref : null);
}

async function baiduDirectory(provider, passcode, fetcher) {
  const headers = { 'accept': 'application/json', 'referer': 'https://pan.baidu.com/' };
  const common = { web: '5', app_id: '250528', channel: 'chunlei', clienttype: '5' };
  let cookie = '';
  if (passcode) {
    const url = new URL('https://pan.baidu.com/share/verify');
    for (const [key, value] of Object.entries({ ...common, surl: provider.shareId })) url.searchParams.set(key, value);
    const result = await requestJson(url.toString(), {
      method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pwd: passcode, vcode: '', vcode_str: '' }).toString(),
    }, fetcher);
    if (Number(result.data?.errno) !== 0) throw new Error('verification failed');
    const setCookies = typeof result.headers.getSetCookie === 'function' ? result.headers.getSetCookie().join(', ') : (result.headers.get('set-cookie') || '');
    const match = setCookies.match(/(?:^|,\s*)BDCLND=([^;,\s]+)/i);
    if (!match) throw new Error('no share cookie');
    cookie = `BDCLND=${match[1]}`;
  }
  return collectDirectory(provider, '', async current => {
    const url = new URL('https://pan.baidu.com/share/list');
    const params = { ...common, shorturl: provider.shareId, page: String(current.page), num: String(PAGE_SIZE), order: 'time', desc: '1', showempty: '0' };
    if (current.ref) params.dir = current.ref; else params.root = '1';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const result = await requestJson(url.toString(), { headers: cookie ? { ...headers, cookie } : headers }, fetcher);
    if (Number(result.data?.errno) !== 0 || !Array.isArray(result.data?.list)) throw new Error('invalid list');
    return result.data.list.map(item => ({ name: item.server_filename, directory: Number(item.isdir) === 1, ref: item.path }));
  }, entry => typeof entry.ref === 'string' && entry.ref.startsWith('/') && entry.ref.length <= 500 ? entry.ref : null);
}
