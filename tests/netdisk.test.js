import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNetdisk, normalizePreview, providerTags, readShareDirectory, startShareScan, continueShareScan, scanSummary } from '../src/netdisk.js';

const response = (data, headers = {}, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

test('detects only supported HTTPS share URLs and reserves a platform tag', () => {
  const quark = detectNetdisk('https://pan.quark.cn/s/mockshare123?pwd=A1b2');
  assert.deepEqual(quark, { id: 'quark', label: '夸克网盘', shareId: 'mockshare123', password: 'A1b2' });
  assert.equal(detectNetdisk('https://pan.baidu.com/s/1short_ABC?pwd=abcd').shareId, 'short_ABC');
  assert.equal(detectNetdisk('https://drive.quark.cn/s/abc?passcode=z12').password, 'z12');
  for (const url of ['http://pan.quark.cn/s/abc', 'https://pan.quark.cn.evil.test/s/abc', 'https://evil.test/s/abc', 'https://drive.quark.cn.evil.test/s/abc', 'https://pan.quark.cn:8443/s/abc', 'https://user@pan.quark.cn/s/abc', 'https://pan.quark.cn/other/abc', 'https://pan.baidu.com/s/short']) assert.equal(detectNetdisk(url), null);
  assert.deepEqual(providerTags(['设计', '百度网盘', '夸克网盘'], 'LINK', 'https://pan.quark.cn/s/abc'), ['夸克网盘', '设计']);
  assert.equal(providerTags(['1','2','3','4','5','6','7','8'], 'LINK', 'https://pan.quark.cn/s/a').length, 8);
});

test('directory snapshots accept only bounded, non-secret names', () => {
  assert.deepEqual(normalizePreview('资料/\n资料/教程.pdf\n资料/教程.pdf').items, ['资料/', '资料/教程.pdf']);
  assert.equal(normalizePreview('pan.baidu.com/s/1SECRET').ok, false);
  assert.equal(normalizePreview('drive.quark.cn/s/SECRET').ok, false);
  assert.equal(normalizePreview('提取码 abcd').ok, false);
  assert.equal(normalizePreview('https://example.com/private').ok, false);
  for (const value of ['ftp://example.com/file', 'magnet:?xt=urn:btih:secret', 'ed2k://private', 'stoken=secret', 'access_token: secret', 'passcode=1234']) {
    assert.equal(normalizePreview(value).ok, false, value);
  }
  assert.equal(normalizePreview(Array.from({ length: 301 }, (_, i) => '文件' + i)).ok, false);
});

test('Quark Skill guest flow reads the root and child without account credentials', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'drive-pc.quark.cn');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(parsed.searchParams.get('access_token'), 'guest_placeholder');
    assert.equal(parsed.searchParams.get('device_id'), 'wild_claw');
    assert.equal(parsed.searchParams.get('pr'), 'ucpro');
    assert.equal(parsed.searchParams.get('fr'), 'third');
    assert.ok(parsed.searchParams.get('req_id'));
    if (parsed.pathname.endsWith('/v2/detail')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { pwd_id: 'privateId', passcode: 'A1b2', page: 1, size: 50, fetch_total: 1, fetch_share: 1 });
      return response({ status: 200, code: 0, data: { token_info: { stoken: 'private-token' }, detail_info: { list: [
        { file_name: '合集', fid: 'dir1', file_type: '0' }, { file_name: '说明.pdf', fid: 'file1', file_type: '1' },
      ] } } });
    }
    assert.ok(parsed.pathname.endsWith('/sharepage/detail'));
    assert.equal(parsed.searchParams.get('stoken'), 'private-token');
    assert.equal(parsed.searchParams.get('pdir_fid'), 'dir1');
    assert.equal(parsed.searchParams.get('_page'), '1');
    assert.equal(parsed.searchParams.get('_size'), '50');
    assert.equal(parsed.searchParams.get('_fetch_total'), '1');
    assert.equal(parsed.searchParams.get('_fetch_share'), '1');
    return response({ code: 0, data: { list: [{ file_name: '第一课.mp4', fid: 'file2', file_type: 1 }] } });
  };
  const result = await readShareDirectory('https://pan.quark.cn/s/privateId?pwd=A1b2', '', fetcher);
  assert.deepEqual(result.items, ['合集/', '说明.pdf', '合集/第一课.mp4']);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 2);
  for (const secret of ['private-token', 'privateId', 'A1b2', 'dir1', 'file2']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Baidu adapter uses only the transient share cookie and returns names, not credentials', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    const parsed = new URL(url); calls.push({ parsed, options });
    assert.equal(parsed.hostname, 'pan.baidu.com'); assert.equal(options.redirect, 'manual');
    if (parsed.pathname === '/share/verify') {
      assert.equal(new URLSearchParams(options.body).get('pwd'), 'code');
      return response({ errno: 0 }, { 'set-cookie': 'BDCLND=secret-cookie; Path=/; HttpOnly' });
    }
    assert.equal(options.headers.cookie, 'BDCLND=secret-cookie');
    assert.equal(parsed.searchParams.get('shorturl'), 'privateId');
    if (parsed.searchParams.get('root') === '1') return response({ errno: 0, list: [{ server_filename: '资料', isdir: 1, path: '/资料' }] });
    return response({ errno: 0, list: [{ server_filename: '说明.txt', isdir: 0, path: '/资料/说明.txt' }] });
  };
  const result = await readShareDirectory('https://pan.baidu.com/s/1privateId', 'code', fetcher);
  assert.deepEqual(result.items, ['资料/', '资料/说明.txt']);
  assert.equal(calls.length, 3);
  for (const secret of ['secret-cookie', 'privateId', 'code']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('adapters fail closed on errors and mark depth, page and response limits', async () => {
  let calls = 0;
  await assert.rejects(readShareDirectory('https://evil.test/s/abc', '', async () => { calls++; }), /仅支持/);
  assert.equal(calls, 0);
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/a', '', async () => { throw new Error('secret upstream detail'); }), error => !error.message.includes('secret') && /手动/.test(error.message));
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/a', 'bad&code', async () => {}), /提取码格式/);
  const many = Array.from({ length: 50 }, (_, i) => ({ file_name: `file${i}`, fid: `f${i}`, dir: false }));
  const result = await readShareDirectory('https://pan.quark.cn/s/a', '', async (url) => {
    calls++;
    if (url.includes('/token?')) return response({ data: { stoken: 'private' } });
    return response({ data: { list: many } });
  });
  assert.equal(result.items.length, 50); // repeated pages cannot inflate the snapshot
  assert.equal(result.truncated, true);
  assert.ok(calls <= 151); // token + at most 150 bounded list attempts
});

test('Quark pagination follows the real metadata envelope before visiting child folders', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/v2/detail')) {
      seen.push('0:1');
      const list = Array.from({ length: 50 }, (_, i) => i === 0
        ? { file_name: '文件夹', fid: 'folder', file_type: '0' }
        : { file_name: `文件${i}`, fid: `file${i}`, dir: '0', file_type: '1' });
      return response({ status: 200, code: 0, data: { token_info: { stoken: 'short-lived' }, detail_info: { list } }, metadata: { _total: 52, _size: 50 } });
    }
    const parent = parsed.searchParams.get('pdir_fid'), page = Number(parsed.searchParams.get('_page'));
    seen.push(`${parent}:${page}`);
    let list, total;
    if (parent === '0' && page === 2) {
      list = [{ file_name: '文件50', fid: 'file50', dir: false }, { file_name: '文件51', fid: 'file51', dir: false }]; total = 52;
    } else if (parent === 'folder') {
      list = [{ file_name: '子文件', fid: 'child', dir: false }]; total = 1;
    } else throw new Error('unexpected page');
    return response({ status: 200, code: 0, data: { list }, metadata: { _total: total, _size: 50, _count: list.length, _page: page } });
  };
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', fetcher);
  assert.deepEqual(seen, ['0:1', '0:2', 'folder:1']);
  assert.equal(result.items.length, 53);
  assert.ok(result.items.includes('文件夹/子文件'));
  assert.ok(result.items.includes('文件51'));
  assert.equal(result.truncated, false);
});

test('Quark honors a smaller reported page size and reads nested files', async () => {
  const pages = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/v2/detail')) {
      pages.push('0:1');
      const list = Array.from({ length: 20 }, (_, i) => ({ file_name: `项目${i}`, fid: i === 0 ? 'folder' : `f${i}`, dir: i === 0 }));
      return response({ code: 0, metadata: { req_id: 'mock' }, data: { token_info: { stoken: 'temporary' }, detail_info: { list, metadata: { _total: 21, _size: 20 } } } });
    }
    const parent = parsed.searchParams.get('pdir_fid'), page = Number(parsed.searchParams.get('_page'));
    pages.push(`${parent}:${page}`);
    const list = parent === '0' ? [{ file_name: '最后一项', fid: 'f20', dir: false }]
      : parent === 'folder' ? [{ file_name: '更深的文件夹', fid: 'deep', dir: '1' }] : [{ file_name: '深层文件.pdf', fid: 'inner', dir: '0' }];
    return response({ code: 0, data: { list }, metadata: { _total: parent === '0' ? 21 : 1, _size: 20 } });
  });
  assert.deepEqual(pages, ['0:1', '0:2', 'folder:1', 'deep:1']);
  assert.ok(result.items.includes('最后一项'));
  assert.ok(result.items.includes('项目0/更深的文件夹/深层文件.pdf'));
  assert.equal(result.truncated, false);
});

test('Quark Skill guest flow falls back to the fixed alternate host without cookies', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', 'Ab12', async (url, options) => {
    const parsed = new URL(url); calls.push({ parsed, options });
    if (parsed.hostname === 'drive-pc.quark.cn') throw new Error('network contained a private secret');
    assert.ok(parsed.pathname.endsWith('/v2/detail'));
    return response({ code: 0, data: { token_info: { stoken: 'temporary' }, detail_info: { list: [{ file_name: '公开名称', fid: 'file', dir: false }] } }, metadata: { _total: 1, _size: 50 } });
  });
  assert.deepEqual(calls.map(call => call.parsed.hostname), ['drive-pc.quark.cn', 'drive-h.quark.cn']);
  assert.ok(calls.every(call => call.options.headers.cookie === undefined && call.options.redirect === 'manual'));
  assert.deepEqual(result.items, ['公开名称']);
  assert.equal(result.truncated, false);
});

test('Quark retries a bad token envelope or detail response on the other fixed host', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async (url, options) => {
    const parsed = new URL(url); calls.push([parsed.hostname, parsed.pathname.replace('/1/clouddrive/share/sharepage/', '')]);
    if (parsed.pathname.endsWith('/v2/detail')) return response({ code: 0, data: {} });
    if (parsed.hostname === 'drive-h.quark.cn' && parsed.pathname.endsWith('/token')) return response({ code: 0, data: {} });
    if (parsed.pathname.endsWith('/token')) return response({ code: 0, data: { stoken: 'temporary' } });
    if (parsed.hostname === 'drive-pc.quark.cn') return response({ code: 0, data: {} });
    return response({ code: 0, data: { list: [{ file_name: '资料', fid: 'f', dir: false }] }, metadata: { _total: 1, _size: 50 } });
  });
  assert.deepEqual(calls, [
    ['drive-pc.quark.cn', 'v2/detail'], ['drive-h.quark.cn', 'v2/detail'],
    ['drive-h.quark.cn', 'token'], ['drive-pc.quark.cn', 'token'],
    ['drive-pc.quark.cn', 'detail'], ['drive-h.quark.cn', 'detail'],
  ]);
  assert.deepEqual(result.items, ['资料']);
});

test('upstream HTTP and business errors are actionable but never expose upstream messages or secrets', async () => {
  let calls = 0;
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/paidSecret?pwd=A1b2', '', async url => {
    calls++;
    if (new URL(url).hostname === 'drive-h.quark.cn') {
      return response({ status: 400, code: 14001, message: 'paidSecret A1b2 token=CREDENTIAL https://secret.test' }, {}, 400);
    }
    throw new Error('network failure with CREDENTIAL');
  }), error => {
    assert.deepEqual(error.diagnostic, { provider: 'quark', stage: 'TOKEN', reason: 'HTTP_ERROR', http_status: 400, provider_code: 14001 });
    assert.match(error.message, /QUARK_TOKEN_HTTP_ERROR \/ HTTP 400 \/ 平台码 14001/);
    for (const secret of ['paidSecret', 'A1b2', 'CREDENTIAL', 'https://secret.test']) assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(calls, 4); // two Skill guest hosts and two legacy token hosts

  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/abc', '', async () => response({ code: 31001, message: 'secret', data: { stoken: 'not-valid' } })), error => {
    assert.equal(error.diagnostic.provider_code, 31001);
    assert.equal(error.diagnostic.reason, 'PROVIDER_ERROR');
    assert.match(error.message, /需要登录/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/abc', '', async () => { throw new DOMException('sensitive', 'AbortError'); }), error => {
    assert.equal(error.diagnostic.reason, 'TIMEOUT');
    assert.match(error.message, /超时/);
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
});

test('3xx redirects are rejected instead of followed', async () => {
  let calls = 0;
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/a', '', async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://challenge.test/' } });
  }), error => {
    assert.equal(error.diagnostic.reason, 'HTTP_ERROR');
    assert.equal(error.diagnostic.http_status, 302);
    assert.ok(!error.message.includes('challenge.test'));
    return true;
  });
  assert.equal(calls, 4); // two Skill guest hosts and two legacy token hosts
});

test('partial directory failures report a sanitized warning without exceeding the shared list budget', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/privateId', '', async url => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/token')) return response({ code: 0, data: { stoken: 'temporary-secret' } });
    if (parsed.searchParams.get('pdir_fid') === '0') {
      return response({ code: 0, data: { list: [{ file_name: '合集', fid: 'private-folder', dir: true }] }, metadata: { _total: 1, _size: 50 } });
    }
    return response({ code: 31001, message: 'temporary-secret privateId private-folder' }, {}, 403);
  });
  assert.deepEqual(result.items, ['合集/']);
  assert.equal(result.truncated, true);
  assert.equal(result.warning.diagnostic.stage, 'DETAIL');
  assert.equal(result.warning.diagnostic.provider_code, 31001);
  assert.match(result.warning.message, /HTTP 403/);
  assert.ok(calls.filter(url => url.pathname.endsWith('/detail')).length <= 150);
  for (const secret of ['temporary-secret', 'privateId', 'private-folder']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('fallback attempts count toward the bounded directory budget', async () => {
  const detailCalls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/a', '', async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/token')) return response({ code: 0, data: { stoken: 'token' } });
    detailCalls.push(parsed);
    if (parsed.searchParams.get('_page') === '2' && parsed.hostname === 'drive-h.quark.cn') throw new Error('temporary network failure');
    return response({ code: 0, data: { list: Array.from({ length: 50 }, (_, i) => ({ file_name: `项目${i}`, fid: `f${i}`, dir: false })) }, metadata: { _total: 1000, _size: 50 } });
  });
  assert.ok(detailCalls.length <= 150);
  assert.equal(result.truncated, false);
  assert.equal(result.items.length, 50);
});

test('Baidu failures expose only bounded numeric diagnostics, not verification secrets', async () => {
  await assert.rejects(readShareDirectory('https://pan.baidu.com/s/1private', 'code', async () => response({ errno: -9, errmsg: 'private code secret-cookie' }, {}, 403)), error => {
    assert.deepEqual(error.diagnostic, { provider: 'baidu', stage: 'VERIFY', reason: 'HTTP_ERROR', http_status: 403, provider_code: -9 });
    assert.ok(!error.message.includes('private'));
    assert.ok(!error.message.includes('secret-cookie'));
    return true;
  });
});

test('Quark opens a single share wrapping folder and lists the names visible on the web page', async () => {
  const folders = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/v2/detail')) {
      folders.push('0');
      return response({ status: 200, code: 0, data: { token_info: { stoken: 'temporary' }, detail_info: { list: [{ file_name: '分享包装', fid: 'wrapper', dir: true }] } }, metadata: { _total: 1, _size: 50 } });
    }
    const folder = parsed.searchParams.get('pdir_fid'); folders.push(folder);
    const list = folder === 'wrapper' ? [{ file_name: 'Top 50', fid: 'top50', dir: true }]
      : Array.from({ length: 50 }, (_, i) => ({ file_name: `电影${i + 1}`, fid: `f${i}`, file_type: 1 }));
    return response({ status: 200, code: 0, data: { list }, metadata: { _total: list.length, _size: 50 } });
  });
  assert.deepEqual(folders, ['0', 'wrapper', 'top50']);
  assert.equal(result.items.length, 52);
  assert.ok(result.items.includes('分享包装/Top 50/电影1'));
  assert.ok(result.items.includes('分享包装/Top 50/电影50'));
  assert.equal(result.truncated, false);
});

test('upstream filenames containing URLs or passcode labels are never published after sanitization', async () => {
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async url => {
    if (new URL(url).pathname.endsWith('/token')) return response({ code: 0, data: { stoken: 'token' } });
    return response({ code: 0, data: { list: [
      { file_name: 'https://private.example/path', fid: 'a', dir: false },
      { file_name: '提取码 A1b2', fid: 'b', dir: false },
      { file_name: '正常文件.txt', fid: 'c', dir: false },
    ] }, metadata: { _total: 3, _size: 50 } });
  });
  assert.deepEqual(result.items, ['正常文件.txt']);
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes('private.example'));
  assert.ok(!JSON.stringify(result).includes('A1b2'));
});

test('Quark rejects HTTP 200 responses whose envelope still reports an error', async () => {
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/a', '', async () => response({ status: 403, data: { stoken: 'must-not-be-used' } })), error => {
    assert.equal(error.diagnostic.stage, 'TOKEN');
    assert.equal(error.diagnostic.reason, 'PROVIDER_ERROR');
    assert.equal(error.diagnostic.http_status, 200);
    assert.ok(!error.message.includes('must-not-be-used'));
    return true;
  });
});

test('oversized upstream responses and nonnumeric error codes remain bounded and private', async () => {
  let calls = 0;
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/a', '', async () => {
    calls++;
    return response({ code: 0, data: { stoken: 'x'.repeat(1024 * 1024 + 1) } });
  }), error => {
    assert.equal(error.diagnostic.reason, 'RESPONSE_TOO_LARGE');
    assert.ok(error.message.length < 300);
    return true;
  });
  assert.equal(calls, 4);
  await assert.rejects(readShareDirectory('https://pan.quark.cn/s/a', '', async () => response({ code: 'secret-token', message: 'private-url' }, {}, 400)), error => {
    assert.equal(error.diagnostic.provider_code, null);
    assert.ok(!error.message.includes('secret-token'));
    assert.ok(!error.message.includes('private-url'));
    return true;
  });
});

test('Skill guest root can be returned without a share token when no continuation is needed', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async (url, options) => {
    calls.push({ url, options });
    assert.ok(new URL(url).pathname.endsWith('/v2/detail'));
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'passcode'), false);
    return response({ status: 200, code: 0, data: { detail_info: { list: [{ file_name: '介绍.txt', fid: 'private-fid', file_type: 1 }] } } });
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.items, ['介绍.txt']);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('private-fid'));
});

test('missing Skill guest token is obtained lazily for a child directory', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async (url, options) => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/v2/detail')) {
      return response({ status: 200, code: 0, data: { detail_info: { list: [{ file_name: '文件夹', fid: 'private-folder', file_type: 0 }] } } });
    }
    if (parsed.pathname.endsWith('/token')) {
      assert.equal(options.method, 'POST');
      return response({ code: 0, data: { stoken: 'private-stoken' } });
    }
    assert.equal(parsed.searchParams.get('stoken'), 'private-stoken');
    assert.equal(parsed.searchParams.get('pdir_fid'), 'private-folder');
    return response({ code: 0, data: { list: [{ file_name: '子文件.txt', fid: 'private-file', file_type: 1 }] } });
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(result.items, ['文件夹/', '文件夹/子文件.txt']);
  assert.equal(result.truncated, false);
  for (const secret of ['private-folder', 'private-file', 'private-stoken']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('missing guest token cannot make an incomplete directory look complete', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/privateId?pwd=Ab12', '', async url => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/v2/detail')) {
      return response({ code: 0, data: { detail_info: { list: [{ file_name: '合集', fid: 'private-folder', dir: true }] } } });
    }
    assert.ok(parsed.pathname.endsWith('/token'));
    return response({ code: 31001, message: 'privateId Ab12 private-folder' }, {}, 403);
  });
  assert.ok(calls.length >= 3);
  assert.deepEqual(result.items, ['合集/']);
  assert.equal(result.truncated, true);
  assert.equal(result.warning.diagnostic.stage, 'TOKEN');
  assert.equal(result.warning.diagnostic.provider_code, 31001);
  for (const secret of ['privateId', 'Ab12', 'private-folder']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('Skill guest flow continues a full page without metadata and does not confuse share total with folder total', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async url => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/v2/detail')) {
      const list = Array.from({ length: 50 }, (_, i) => ({ file_name: `文件${i}`, fid: `f${i}`, file_type: 1 }));
      return response({ code: 0, data: { token_info: { stoken: 'temporary' }, detail_info: { list, share: { file_num: 5000 } } } });
    }
    assert.equal(parsed.searchParams.get('_page'), '2');
    return response({ code: 0, data: { list: [{ file_name: '最后文件', fid: 'last', file_type: 1 }], share: { file_num: 5000 } } });
  });
  assert.equal(calls.length, 2);
  assert.equal(result.items.length, 51);
  assert.equal(result.items[50], '最后文件');
  assert.equal(result.truncated, false);
});

test('Skill guest flow rejects error envelopes even if a response contains fake files and a token', async () => {
  const calls = [];
  const result = await readShareDirectory('https://pan.quark.cn/s/abc', '', async url => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/v2/detail')) {
      return response({ status: -1, data: { token_info: { stoken: 'fake-secret' }, detail_info: { list: [{ file_name: '不可采信', fid: 'fake' }] } } });
    }
    if (parsed.pathname.endsWith('/token')) return response({ code: 0, data: { stoken: 'real-ephemeral' } });
    return response({ code: 0, data: { list: [{ file_name: '可信响应', fid: 'file', file_type: 1 }] } });
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(result.items, ['可信响应']);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
});

test('directory scans resume from serialized state and report progress', async () => {
  const calls = [];
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/v2/detail')) {
      calls.push('root:1');
      return response({ code: 0, data: { token_info: { stoken: 'temporary' }, detail_info: { list: [
        { file_name: '合集A', fid: 'dirA', file_type: '0' },
        { file_name: '合集B', fid: 'dirB', file_type: '0' },
        { file_name: '说明.pdf', fid: 'file1', file_type: '1' },
      ] } }, metadata: { _total: 3, _size: 50 } });
    }
    const parent = parsed.searchParams.get('pdir_fid');
    calls.push(`${parent}:1`);
    return response({ code: 0, data: { list: [{ file_name: `${parent}.mp4`, fid: 'file', file_type: 1 }] }, metadata: { _total: 1, _size: 50 } });
  };

  let state = await startShareScan('https://pan.quark.cn/s/abc', '', fetcher);
  // The scan state must survive a D1 round trip between batches.
  state = JSON.parse(JSON.stringify(state));
  const first = scanSummary(await continueShareScan(state, '', fetcher, 1));
  assert.equal(first.done, false);
  assert.deepEqual(first.items, ['合集A/', '合集B/', '说明.pdf', '合集A/dirA.mp4']);
  assert.equal(first.progress.pending, 1);
  assert.ok(first.progress.percent > 0 && first.progress.percent < 100);

  state = JSON.parse(JSON.stringify(state));
  const second = scanSummary(await continueShareScan(state, '', fetcher, 5));
  assert.equal(second.done, true);
  assert.deepEqual(second.items, ['合集A/', '合集B/', '说明.pdf', '合集A/dirA.mp4', '合集B/dirB.mp4']);
  assert.equal(second.progress.percent, 100);
  assert.deepEqual(calls, ['root:1', 'dirA:1', 'dirB:1']); // the cached root page is never fetched twice
  assert.equal(second.truncated, false);
});

test('a batch never spends more upstream list calls than its budget', async () => {
  const calls = [];
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/v2/detail')) {
      return response({ code: 0, data: { token_info: { stoken: 'temporary' }, detail_info: { list: Array.from({ length: 8 }, (_, i) => ({ file_name: `目录${i}`, fid: `dir${i}`, file_type: 0 })) } }, metadata: { _total: 8, _size: 50 } });
    }
    calls.push(parsed.searchParams.get('pdir_fid'));
    return response({ code: 0, data: { list: [{ file_name: '文件.txt', fid: 'f', file_type: 1 }] }, metadata: { _total: 1, _size: 50 } });
  };
  const state = await startShareScan('https://pan.quark.cn/s/abc', '', fetcher);
  const batch = scanSummary(await continueShareScan(state, '', fetcher, 3));
  assert.equal(calls.length, 3);
  assert.equal(batch.done, false);
  assert.equal(batch.progress.pending, 5);
  assert.ok(batch.progress.percent > 0 && batch.progress.percent < 100);
});
