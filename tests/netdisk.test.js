import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNetdisk, normalizePreview, providerTags, readShareDirectory } from '../src/netdisk.js';

const response = (data, headers = {}) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...headers } });

test('detects only supported HTTPS share URLs and reserves a platform tag', () => {
  const quark = detectNetdisk('https://pan.quark.cn/s/3143f873f6dc?pwd=A1b2');
  assert.deepEqual(quark, { id: 'quark', label: '夸克网盘', shareId: '3143f873f6dc', password: 'A1b2' });
  assert.equal(detectNetdisk('https://pan.baidu.com/s/1short_ABC?pwd=abcd').shareId, 'short_ABC');
  for (const url of ['http://pan.quark.cn/s/abc', 'https://pan.quark.cn.evil.test/s/abc', 'https://evil.test/s/abc', 'https://pan.quark.cn:8443/s/abc', 'https://user@pan.quark.cn/s/abc', 'https://pan.quark.cn/other/abc', 'https://pan.baidu.com/s/short']) assert.equal(detectNetdisk(url), null);
  assert.deepEqual(providerTags(['设计', '百度网盘', '夸克网盘'], 'LINK', 'https://pan.quark.cn/s/abc'), ['夸克网盘', '设计']);
  assert.equal(providerTags(['1','2','3','4','5','6','7','8'], 'LINK', 'https://pan.quark.cn/s/a').length, 8);
});

test('directory snapshots accept only bounded, non-secret names', () => {
  assert.deepEqual(normalizePreview('资料/\n资料/教程.pdf\n资料/教程.pdf').items, ['资料/', '资料/教程.pdf']);
  assert.equal(normalizePreview('pan.baidu.com/s/1SECRET').ok, false);
  assert.equal(normalizePreview('提取码 abcd').ok, false);
  assert.equal(normalizePreview('https://example.com/private').ok, false);
  assert.equal(normalizePreview(Array.from({ length: 151 }, (_, i) => '文件' + i)).ok, false);
});

test('Quark adapter traverses one level, never sends cookies or exposes access tokens', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'drive-pc.quark.cn');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.cookie, undefined);
    if (parsed.pathname.endsWith('/token')) {
      assert.deepEqual(JSON.parse(options.body), { pwd_id: 'privateId', passcode: 'A1b2', support_visit_limit_private_share: true });
      return response({ data: { stoken: 'private-token' } });
    }
    assert.equal(parsed.searchParams.get('stoken'), 'private-token');
    if (parsed.searchParams.get('pdir_fid') === '0') return response({ data: { list: [
      { file_name: '合集', fid: 'dir1', dir: true }, { file_name: '说明.pdf', fid: 'file1', dir: false },
    ] } });
    return response({ data: { list: [{ file_name: '第一课.mp4', fid: 'file2', dir: false }] } });
  };
  const result = await readShareDirectory('https://pan.quark.cn/s/privateId?pwd=A1b2', '', fetcher);
  assert.deepEqual(result.items, ['合集/', '说明.pdf', '合集/第一课.mp4']);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 3);
  for (const secret of ['private-token', 'privateId', 'A1b2', 'dir1', 'file2']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Baidu adapter uses only the transient share cookie and returns names, not credentials', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    const parsed = new URL(url); calls.push({ parsed, options });
    assert.equal(parsed.hostname, 'pan.baidu.com'); assert.equal(options.redirect, 'error');
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
  const many = Array.from({ length: 100 }, (_, i) => ({ file_name: `file${i}`, fid: `f${i}`, dir: false }));
  const result = await readShareDirectory('https://pan.quark.cn/s/a', '', async (url) => {
    calls++;
    if (url.includes('/token?')) return response({ data: { stoken: 'private' } });
    return response({ data: { list: many } });
  });
  assert.equal(result.items.length, 100); // repeated pages cannot inflate the snapshot
  assert.equal(result.truncated, true);
  assert.ok(calls <= 7); // token + 6 bounded list calls
});
