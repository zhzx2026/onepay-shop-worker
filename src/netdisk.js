// Public-share adapters. These endpoints are unofficial and may be blocked or
// change without notice. Never fetch a user-supplied URL or follow redirects.
export const MAX_PREVIEW_FILES = 150;
const QUARK_PAGE_SIZE = 50;
const BAIDU_PAGE_SIZE = 100;
const MAX_LIST_CALLS = 6;
const MAX_DEPTH = 2; // root and one child level
const MAX_JSON_BYTES = 1024 * 1024;
const QUARK_HOSTS = ['drive-h.quark.cn', 'drive-pc.quark.cn'];
const QUARK_PATH = '/1/clouddrive/share/sharepage/';

export function detectNetdisk(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,100})\/?$/);
    if (!match) return null;
    if (url.hostname === 'pan.quark.cn' || url.hostname === 'drive.quark.cn') {
      return { id: 'quark', label: '夸克网盘', shareId: match[1], password: url.searchParams.get('pwd') || url.searchParams.get('passcode') || '' };
    }
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
  return /https?:\/\/|(?:(?:pan|drive)\.quark\.cn|pan\.baidu\.com)|(?:提取码|访问码|访问密码|分享密码)/i.test(text);
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
  const original = String(value || '').trim();
  if (!original || looksPrivate(original)) return '';
  const name = original.replace(/[\u0000-\u001f\u007f/\\]/g, ' ');
  if (looksPrivate(name)) return '';
  return name.slice(0, 120);
}

// These errors carry only bounded machine-readable facts, never an upstream
// message, URL, share ID, passcode, cookie, file ID, or access token.
class UpstreamError extends Error {
  constructor(provider, stage, reason, { httpStatus = null, providerCode = null } = {}) {
    super(reason);
    this.provider = provider;
    this.stage = stage;
    this.reason = reason;
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    this.providerCode = Number.isSafeInteger(providerCode) && Math.abs(providerCode) <= 999999999 ? providerCode : null;
  }
}

function numericCode(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d{1,9}$/.test(String(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function responseCode(provider, data) {
  return numericCode(provider === 'quark' ? data?.code : data?.errno);
}

async function requestJson(url, options, fetcher, provider, stage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: controller.signal });
    const status = response.status;
    if (!response.body) throw new UpstreamError(provider, stage, response.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR', { httpStatus: status });
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        try { await reader.cancel(); } catch { /* Ignore cleanup failures. */ }
        throw new UpstreamError(provider, stage, 'RESPONSE_TOO_LARGE', { httpStatus: status });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { data = null; }
    if (!response.ok) {
      // Quark can send its business code in an HTTP 400/403 JSON response.
      throw new UpstreamError(provider, stage, 'HTTP_ERROR', { httpStatus: status, providerCode: responseCode(provider, data) });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new UpstreamError(provider, stage, 'INVALID_RESPONSE', { httpStatus: status });
    }
    return { data, headers: response.headers, status };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    const timeout = controller.signal.aborted || error?.name === 'AbortError';
    throw new UpstreamError(provider, stage, timeout ? 'TIMEOUT' : 'NETWORK');
  } finally { clearTimeout(timer); }
}

function checkProviderCode(result, provider, stage, key, required = false) {
  const raw = result.data?.[key];
  if (raw !== undefined || required) {
    const code = numericCode(raw);
    if (code !== 0) throw new UpstreamError(provider, stage, 'PROVIDER_ERROR', { httpStatus: result.status, providerCode: code });
  }
  // Some upstream gateways put an error in the JSON envelope despite HTTP 200.
  const envelopeStatus = numericCode(result.data?.status);
  if (provider === 'quark' && envelopeStatus !== null && envelopeStatus !== 0 && (envelopeStatus < 100 || envelopeStatus >= 400)) {
    throw new UpstreamError(provider, stage, 'PROVIDER_ERROR', { httpStatus: result.status });
  }
}

function providerError(provider, error) {
  const known = error instanceof UpstreamError && error.provider === provider.id ? error : null;
  const stage = known?.stage || 'REQUEST';
  const reason = known?.reason || 'INVALID_RESPONSE';
  const status = known?.httpStatus ?? null;
  const code = known?.providerCode ?? null;
  const stageLabel = { TOKEN: '获取分享权限', DETAIL: '读取目录', VERIFY: '验证提取码', REQUEST: '读取分享' }[stage] || '读取分享';
  let cause = '平台返回异常或拒绝了公开访问';
  if (reason === 'NETWORK') cause = '无法连接网盘，可能是运行环境网络或平台限制';
  else if (reason === 'TIMEOUT') cause = '访问网盘超时';
  else if (reason === 'RESPONSE_TOO_LARGE') cause = '网盘返回的数据过大';
  else if (reason === 'INVALID_RESPONSE') cause = '网盘返回了无法识别的数据';
  else if (reason === 'LIST_LIMIT') cause = '已达到单次读取的请求上限';
  else if (status === 429) cause = '请求被平台限流';
  else if (provider.id === 'quark' && code === 31001) cause = '平台提示此分享需要登录或不允许游客访问';
  const parts = [`${provider.id.toUpperCase()}_${stage}_${reason}`];
  if (status !== null) parts.push(`HTTP ${status}`);
  if (code !== null) parts.push(`平台码 ${code}`);
  const message = `${provider.label}${stageLabel}失败：${cause}（诊断：${parts.join(' / ')}）。请检查分享权限和提取码后重试，或手动填写目录。`;
  return Object.assign(new Error(message), {
    diagnostic: { provider: provider.id, stage, reason, http_status: status, provider_code: code },
  });
}

export async function readShareDirectory(value, passcode = '', fetcher = fetch) {
  const provider = detectNetdisk(value);
  if (!provider) throw new Error('仅支持夸克或百度网盘的 HTTPS 分享链接，请手动填写其他目录。');
  const pwd = String(passcode || provider.password || '').trim();
  if (pwd && !/^[A-Za-z0-9]{1,16}$/.test(pwd)) throw new Error('提取码格式无效，请填写 1–16 位字母或数字。');
  try {
    return provider.id === 'quark'
      ? await quarkDirectory(provider, pwd, fetcher)
      : await baiduDirectory(provider, pwd, fetcher);
  } catch (error) {
    throw providerError(provider, error);
  }
}

async function collectDirectory(provider, initial, list, makeChild, { expandSingleRoot = false } = {}) {
  const queue = [{ ref: initial, prefix: '', depth: 0, page: 1 }];
  const seen = new Set(); const items = [];
  let calls = 0, truncated = false, warning = null;
  while (queue.length && calls < MAX_LIST_CALLS && items.length < MAX_PREVIEW_FILES) {
    const current = queue.shift();
    let page;
    try { page = await list(current); calls++; }
    catch (error) {
      if (!calls) throw error;
      truncated = true;
      const safe = providerError(provider, error);
      warning = { message: safe.message, diagnostic: safe.diagnostic };
      break;
    }
    const entries = page.entries;
    // Quark can wrap the share in a single top-level folder, whereas its web
    // page starts inside it. Keep the name for context but do not spend a
    // preview depth on that wrapping layer.
    const wrappedRoot = expandSingleRoot && current.depth === 0 && current.ref === initial && current.page === 1 && !page.hasMore && entries.length === 1 && entries[0].directory;
    const childDepth = wrappedRoot ? 0 : current.depth + 1;
    for (const entry of entries) {
      const name = safeName(entry.name);
      if (!name) { truncated = true; continue; }
      const path = `${current.prefix}${name}${entry.directory ? '/' : ''}`;
      if (path.length > 240) { truncated = true; continue; }
      if (!seen.has(path)) { seen.add(path); items.push(path); }
      if (entry.directory) {
        if (childDepth < MAX_DEPTH) {
          const ref = makeChild(entry);
          if (ref) queue.push({ ref, prefix: path, depth: childDepth, page: 1 });
          else truncated = true;
        } else truncated = true;
      }
      if (items.length >= MAX_PREVIEW_FILES) { truncated = true; break; }
    }
    // Fetch the remaining pages of this folder before consuming the bounded
    // request budget on child folders.
    if (page.hasMore) queue.unshift({ ...current, page: current.page + 1 });
  }
  if (queue.length) truncated = true;
  return { provider: { id: provider.id, label: provider.label }, items, truncated, ...(warning ? { warning } : {}) };
}

function nonnegativeInteger(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function quarkHasMore(result, entries, page) {
  const data = result.data.data || {};
  const detail = data.detail_info || data;
  const metadata = result.data.metadata || {};
  const detailMetadata = detail.metadata || {};
  // Do not use share.file_num: it may count the whole share, not this folder.
  const total = nonnegativeInteger(metadata._total ?? metadata.total ?? detailMetadata._total ?? detailMetadata.total ?? detail.total ?? detail.total_num ?? detail.total_count);
  const reportedSize = nonnegativeInteger(metadata._size ?? detailMetadata._size);
  const pageSize = reportedSize && reportedSize <= QUARK_PAGE_SIZE ? reportedSize : QUARK_PAGE_SIZE;
  return total === null ? entries.length >= pageSize : page * pageSize < total;
}

// Prefer a diagnostic that includes a platform code or HTTP status if the
// fallback host fails at the network layer and would otherwise obscure it.
function betterError(first, next) {
  const score = error => error instanceof UpstreamError ? (error.providerCode !== null ? 2 : error.httpStatus !== null ? 1 : 0) : -1;
  return !first || score(next) >= score(first) ? next : first;
}

async function quarkDirectory(provider, passcode, fetcher) {
  const legacyQuery = { pr: 'ucpro', fr: 'pc', uc_param_str: '', ver: '2' };
  // The Skill's guest transport uses this literal placeholder, not an account
  // access token. Do not substitute an account credential or forward cookies.
  const skillQuery = () => ({ req_id: crypto.randomUUID(), access_token: 'guest_placeholder', device_id: 'wild_claw', pr: 'ucpro', fr: 'third' });
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'origin': 'https://pan.quark.cn',
    'referer': 'https://pan.quark.cn/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };
  let preferredHost = QUARK_HOSTS[0], listAttempts = 0;
  const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
  async function call(path, params, options, stage) {
    let best = null;
    const hosts = [preferredHost, ...QUARK_HOSTS.filter(host => host !== preferredHost)];
    for (const host of hosts) {
      if (stage === 'DETAIL') {
        if (listAttempts >= MAX_LIST_CALLS) throw best || new UpstreamError(provider.id, stage, 'LIST_LIMIT');
        listAttempts++;
      }
      const url = new URL(`https://${host}${QUARK_PATH}${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      try {
        const result = await requestJson(url.toString(), options, fetcher, provider.id, stage);
        checkProviderCode(result, provider.id, stage, 'code');
        if (stage === 'TOKEN') {
          if (!validToken(result.data?.data?.stoken)) throw new UpstreamError(provider.id, stage, 'INVALID_RESPONSE', { httpStatus: result.status });
        } else if (!Array.isArray(result.data?.data?.list)) {
          throw new UpstreamError(provider.id, stage, 'INVALID_RESPONSE', { httpStatus: result.status });
        }
        preferredHost = host;
        return result;
      } catch (error) {
        best = betterError(best, error);
      }
    }
    throw best || new UpstreamError(provider.id, stage, 'INVALID_RESPONSE');
  }
  async function legacyToken() {
    const result = await call('token', legacyQuery, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ pwd_id: provider.shareId, passcode, support_visit_limit_private_share: true }),
    }, 'TOKEN');
    return result.data.data.stoken;
  }
  // In the Skill's guest transport, this POST returns both the first root page
  // and a short-lived stoken. Its network adapter targets drive-pc first.
  async function skillRoot() {
    let best = null;
    for (const host of ['drive-pc.quark.cn', 'drive-h.quark.cn']) {
      if (listAttempts >= MAX_LIST_CALLS) throw best || new UpstreamError(provider.id, 'TOKEN', 'LIST_LIMIT');
      listAttempts++;
      const url = new URL(`https://${host}${QUARK_PATH}v2/detail`);
      for (const [key, value] of Object.entries(skillQuery())) url.searchParams.set(key, value);
      try {
        const result = await requestJson(url.toString(), {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ pwd_id: provider.shareId, ...(passcode ? { passcode } : {}), page: 1, size: QUARK_PAGE_SIZE, fetch_total: 1, fetch_share: 1 }),
        }, fetcher, provider.id, 'TOKEN');
        checkProviderCode(result, provider.id, 'TOKEN', 'code');
        const list = result.data?.data?.detail_info?.list;
        const token = result.data?.data?.token_info?.stoken;
        if (!Array.isArray(list) || (token != null && token !== '' && !validToken(token))) {
          throw new UpstreamError(provider.id, 'TOKEN', 'INVALID_RESPONSE', { httpStatus: result.status });
        }
        preferredHost = host;
        return { result, list, token: token || '' };
      } catch (error) {
        best = betterError(best, error);
      }
    }
    throw best || new UpstreamError(provider.id, 'TOKEN', 'INVALID_RESPONSE');
  }
  let firstPage = null, stoken = '';
  try {
    firstPage = await skillRoot();
    stoken = firstPage.token;
  } catch (skillError) {
    // Keep the previous public-share token flow as a compatibility fallback.
    try { stoken = await legacyToken(); }
    catch (legacyError) { throw betterError(skillError, legacyError); }
  }
  return collectDirectory(provider, '0', async current => {
    const root = current.ref === '0';
    let response, list;
    if (firstPage && root && current.page === 1) {
      ({ result: response, list } = firstPage);
    } else {
      // A valid first page need not contain a token. Fetch one only if a
      // subsequent page/folder actually has to be read; otherwise keep the page.
      if (!stoken) stoken = await legacyToken();
      const params = firstPage
        ? { ...skillQuery(), pwd_id: provider.shareId, stoken, pdir_fid: current.ref, _page: String(current.page), _size: String(QUARK_PAGE_SIZE), _fetch_total: '1', _fetch_share: '1' }
        : { ...legacyQuery, pwd_id: provider.shareId, stoken, pdir_fid: current.ref, force: '0', _page: String(current.page), _size: String(QUARK_PAGE_SIZE), _fetch_banner: root ? '1' : '0', _fetch_share: root ? '1' : '0', fetch_relate_conversation: '0', _fetch_total: '1', _sort: 'file_type:asc,file_name:asc' };
      response = await call('detail', params, { headers }, 'DETAIL');
      list = response.data.data.list;
    }
    return {
      entries: list.map(item => ({ name: item?.file_name, directory: item?.dir === true || item?.dir === 1 || item?.dir === '1' || item?.file_type === 0 || item?.file_type === '0', ref: item?.fid })),
      hasMore: quarkHasMore(response, list, current.page),
    };
  }, entry => /^[A-Za-z0-9_-]{1,128}$/.test(String(entry.ref || '')) ? entry.ref : null, { expandSingleRoot: true });
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
    }, fetcher, provider.id, 'VERIFY');
    checkProviderCode(result, provider.id, 'VERIFY', 'errno', true);
    const setCookies = typeof result.headers.getSetCookie === 'function' ? result.headers.getSetCookie().join(', ') : (result.headers.get('set-cookie') || '');
    const match = setCookies.match(/(?:^|,\s*)BDCLND=([^;,\s]+)/i);
    if (!match) throw new UpstreamError(provider.id, 'VERIFY', 'INVALID_RESPONSE', { httpStatus: result.status });
    cookie = `BDCLND=${match[1]}`;
  }
  return collectDirectory(provider, '', async current => {
    const url = new URL('https://pan.baidu.com/share/list');
    const params = { ...common, shorturl: provider.shareId, page: String(current.page), num: String(BAIDU_PAGE_SIZE), order: 'time', desc: '1', showempty: '0' };
    if (current.ref) params.dir = current.ref; else params.root = '1';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const result = await requestJson(url.toString(), { headers: cookie ? { ...headers, cookie } : headers }, fetcher, provider.id, 'DETAIL');
    checkProviderCode(result, provider.id, 'DETAIL', 'errno', true);
    if (!Array.isArray(result.data?.list)) throw new UpstreamError(provider.id, 'DETAIL', 'INVALID_RESPONSE', { httpStatus: result.status });
    return { entries: result.data.list.map(item => ({ name: item.server_filename, directory: Number(item.isdir) === 1, ref: item.path })), hasMore: result.data.list.length >= BAIDU_PAGE_SIZE };
  }, entry => typeof entry.ref === 'string' && entry.ref.startsWith('/') && entry.ref.length <= 500 ? entry.ref : null);
}
