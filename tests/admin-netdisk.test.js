import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
const catalogCode = html.slice(html.indexOf("let catalogSource = 'manual'"), html.indexOf('async function generateCover('));
const saveCode = html.slice(html.indexOf('async function saveGoods('), html.indexOf('async function toggleGoods('));

function makeNode(value = '') {
  const attributes = {}, classes = new Set();
  return {
    value, textContent: '', disabled: false,
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: name => { delete attributes[name]; },
    getAttribute: name => attributes[name],
    classList: {
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
  };
}

function makeEditor() {
  const nodes = {};
  for (const id of ['pLink', 'pShareCode', 'pPreview', 'catalogStatus', 'providerHint', 'readCatalogButton',
    'pId', 'pTitle', 'pSummary', 'pDesc', 'pPrice', 'pCover', 'pCategory', 'pTags', 'pType', 'pText',
    'pFileKey', 'pFileName', 'pStock', 'pStatus', 'pSort', 'pKind', 'pRepeat', 'pSubMode', 'pSubDays', 'pFrequency', 'pSeriesPreview', 'pCatalogPartial', 'pSeriesPartial']) nodes[id] = makeNode();
  Object.assign(nodes.pKind, { value: 'SINGLE' });
  Object.assign(nodes.pType, { value: 'LINK' });
  Object.assign(nodes.pTitle, { value: '测试商品' });
  Object.assign(nodes.pPrice, { value: '10' });
  Object.assign(nodes.pStatus, { value: 'ACTIVE' });
  const reads = [], saves = [];
  const context = vm.createContext({
    URL, AbortController,
    $: selector => nodes[selector.slice(1)],
    api: (path, options) => {
      if (path === '/api/admin/netdisk/preview') {
        return new Promise((resolve, reject) => reads.push({ options, resolve, reject }));
      }
      if (path.startsWith('/api/admin/products')) { saves.push(JSON.parse(options.body)); return Promise.resolve({}); }
      throw new Error('unexpected API');
    },
    withBusy: (_button, callback) => callback(),
    toast: () => {}, cancelEdit: () => {}, loadCategories: async () => {}, loadGoods: async () => {},
  });
  vm.runInContext(catalogCode + '\n' + saveCode, context);
  return { context, nodes, reads, saves };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function begin(editor, url = 'https://pan.quark.cn/s/first') {
  editor.nodes.pLink.value = url;
  editor.context.onShareLinkInput();
  editor.context.onShareLinkChanged();
  assert.equal(editor.reads.length, 1);
}

test('changing the passcode allows an immediate retry and an older response cannot overwrite it', async () => {
  const editor = makeEditor(); begin(editor);
  assert.equal(editor.nodes.readCatalogButton.disabled, true);
  editor.nodes.pShareCode.value = 'A123'; editor.context.onShareCodeChanged();
  assert.equal(editor.reads[0].options.signal.aborted, true);
  assert.equal(editor.nodes.readCatalogButton.disabled, false);
  assert.match(editor.nodes.catalogStatus.textContent, /提取码已变更/);
  const latest = editor.context.fetchCatalog(editor.nodes.readCatalogButton);
  assert.equal(editor.reads.length, 2);
  assert.equal(JSON.parse(editor.reads[1].options.body).passcode, 'A123');
  editor.reads[0].resolve({ provider: { id: 'quark' }, items: ['旧目录'], truncated: false });
  await flush();
  assert.equal(editor.nodes.pPreview.value, '');
  assert.equal(editor.nodes.readCatalogButton.disabled, true);
  editor.reads[1].resolve({ provider: { id: 'quark' }, items: ['新目录/'], truncated: true, warning: { message: '读取部分失败（诊断：QUARK_DETAIL_HTTP_ERROR / HTTP 403）' } });
  await latest;
  assert.equal(editor.nodes.pPreview.value, '新目录/');
  assert.match(editor.nodes.catalogStatus.textContent, /仅部分目录.*HTTP 403/);
  assert.equal(editor.nodes.readCatalogButton.disabled, false);
});

test('editing a link or directory invalidates the pending read immediately', async () => {
  const editor = makeEditor(); begin(editor);
  editor.nodes.pLink.value = 'https://pan.quark.cn/s/second';
  editor.context.onShareLinkInput();
  assert.equal(editor.reads[0].options.signal.aborted, true);
  editor.context.onShareLinkChanged();
  assert.equal(editor.reads.length, 2);
  editor.nodes.pPreview.value = '手工文件'; editor.context.markCatalogManual();
  assert.equal(editor.reads[1].options.signal.aborted, true);
  editor.reads[0].reject(new Error('旧链接错误'));
  editor.reads[1].resolve({ provider: { id: 'quark' }, items: ['不得覆盖'] });
  await flush();
  assert.equal(editor.nodes.pPreview.value, '手工文件');
  assert.match(editor.nodes.catalogStatus.textContent, /手动编辑/);
  assert.equal(editor.nodes.readCatalogButton.disabled, false);
});

test('saving waits for a replacement read started while the previous read was pending', async () => {
  const editor = makeEditor(); begin(editor);
  const saving = editor.context.saveGoods({});
  await flush();
  editor.nodes.pShareCode.value = 'A123'; editor.context.onShareCodeChanged();
  editor.context.fetchCatalog(editor.nodes.readCatalogButton);
  editor.reads[0].resolve({ provider: { id: 'quark' }, items: ['旧文件'] });
  await flush();
  assert.equal(editor.saves.length, 0);
  editor.reads[1].resolve({ provider: { id: 'quark' }, items: ['新文件'] });
  await saving;
  assert.equal(editor.saves.length, 1);
  assert.equal(editor.saves[0].preview_files, '新文件');
  assert.equal(editor.saves[0].delivery_url, 'https://pan.quark.cn/s/first');
});

test('saving notices a link changed during an earlier read and waits for its new snapshot', async () => {
  const editor = makeEditor(); begin(editor);
  const saving = editor.context.saveGoods({});
  await flush();
  editor.nodes.pLink.value = 'https://drive.quark.cn/s/second';
  editor.context.onShareLinkInput();
  editor.reads[0].resolve({ provider: { id: 'quark' }, items: ['旧文件'] });
  await flush();
  assert.equal(editor.reads.length, 2);
  assert.equal(editor.saves.length, 0);
  editor.reads[1].resolve({ provider: { id: 'quark' }, items: ['第二个链接的目录'] });
  await saving;
  assert.equal(editor.saves[0].delivery_url, 'https://drive.quark.cn/s/second');
  assert.equal(editor.saves[0].preview_files, '第二个链接的目录');
});

test('frontend recognizes only the same safe share URLs as the server', () => {
  const editor = makeEditor();
  for (const link of ['https://pan.quark.cn/s/a', 'https://drive.quark.cn/s/a', 'https://pan.baidu.com/s/1a']) {
    editor.nodes.pLink.value = link;
    assert.ok(editor.context.updateProviderHint());
  }
  for (const link of ['https://user@pan.quark.cn/s/a', 'https://pan.quark.cn:8443/s/a', 'https://drive.quark.cn.evil.test/s/a', 'https://pan.baidu.com/s/a']) {
    editor.nodes.pLink.value = link;
    assert.equal(editor.context.updateProviderHint(), '');
  }
});

test('manually editing a partial directory retains the partial warning until explicitly cleared', async () => {
  const editor = makeEditor(); begin(editor);
  editor.reads[0].resolve({ provider: { id: 'quark' }, items: ['文件夹/', '文件夹/文件.txt'], truncated: true });
  await flush();
  assert.equal(editor.nodes.pCatalogPartial.checked, true);
  editor.nodes.pPreview.value += '\n补充文件.txt'; editor.context.markCatalogManual();
  await editor.context.saveGoods({});
  assert.equal(editor.saves[0].preview_truncated, true);
  editor.nodes.pCatalogPartial.checked = false; editor.context.onCatalogPartialChanged();
  await editor.context.saveGoods({});
  assert.equal(editor.saves[1].preview_truncated, false);
});

test('large directories are read in batches and keep the progress bar busy between them', async () => {
  const editor = makeEditor(); begin(editor);
  assert.equal(JSON.parse(editor.reads[0].options.body).scan_id, '');
  editor.reads[0].resolve({ provider: { id: 'quark' }, items: ['第一页/'], truncated: false, done: false, scan_id: 'nds_batch1', progress: { percent: 40, pending: 3 } });
  await flush();
  assert.equal(editor.reads.length, 2);
  assert.equal(JSON.parse(editor.reads[1].options.body).scan_id, 'nds_batch1');
  assert.equal(editor.nodes.readCatalogButton.disabled, true);
  editor.reads[1].resolve({ provider: { id: 'quark' }, items: ['第一页/', '第一页/文件.txt'], truncated: false, done: true, scan_id: '', progress: { percent: 100, pending: 0 } });
  await flush();
  assert.equal(editor.nodes.pPreview.value, '第一页/\n第一页/文件.txt');
  assert.match(editor.nodes.catalogStatus.textContent, /已读取 2 项/);
  assert.equal(editor.nodes.readCatalogButton.disabled, false);
});
