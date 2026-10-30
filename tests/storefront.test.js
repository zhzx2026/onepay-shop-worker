import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../public/storefront.js', import.meta.url), 'utf8');

function makeStore({ config = {}, auth = {} } = {}) {
  const listeners = {};
  const nodes = {};
  const document = {
    title: '全部商品 · 云端积分商店',
    querySelector: () => null,
    querySelectorAll: selector => nodes[selector] || [],
    addEventListener: (type, handler) => { listeners[type] = handler; },
  };
  class HTMLImageElement {
    constructor(fallback) { this.dataset = { coverFallback: fallback }; this.src = ''; }
  }
  const context = vm.createContext({
    document,
    window: {},
    location: { search: '' },
    URLSearchParams,
    HTMLImageElement,
    fetch: async path => ({ ok: true, json: async () => path === '/api/config' ? config : auth }),
  });
  vm.runInContext(script, context);
  return { store: context.window.Store, document, nodes, listeners, HTMLImageElement };
}

test('parent category, tags, keywords and sorting are applied without mutating products', () => {
  const { store } = makeStore();
  const categories = [
    { id: 'parent', parent_id: null },
    { id: 'child', parent_id: 'parent' },
    { id: 'other', parent_id: null },
  ];
  const products = [
    { id: 'one', title: '设计模板', summary: '创意', category_id: 'child', tags: ['设计'], price_points: 100, created_at: '2026-01-01' },
    { id: 'two', title: '设计工具', summary: '', category_id: 'parent', tags: ['设计'], price_points: 30, created_at: '2026-02-01' },
    { id: 'three', title: '其他商品', summary: '', category_id: 'other', tags: [], price_points: 10, created_at: '2026-03-01' },
  ];
  assert.deepEqual(Array.from(store.categoryIds('parent', categories)), ['parent', 'child']);
  const result = store.filterProducts(products, categories, { category: 'parent', tag: '设计', q: '设计', sort: 'price-asc' });
  assert.deepEqual(Array.from(result, item => item.id), ['two', 'one']);
  assert.deepEqual(products.map(item => item.id), ['one', 'two', 'three']);
  const newest = store.filterProducts(products, categories, { category: '', tag: '', q: '', sort: 'newest' });
  assert.deepEqual(Array.from(newest, item => item.id), ['three', 'two', 'one']);
});

test('product covers are stable, escaped and recover from a broken custom image', () => {
  const { store, listeners, HTMLImageElement } = makeStore();
  const product = { id: 'prd_1', cover_url: 'https://example.com/a?x=1&y="2"', delivery_label: '<文本>' };
  const first = store.productCover(product, 0);
  const second = store.productCover(product, 3);
  assert.equal(first, second);
  assert.match(first, /x=1&amp;y=&quot;2&quot;/);
  assert.match(first, /&lt;文本&gt;/);
  assert.match(first, /data-cover-fallback="\/assets\/product-[1-4]\.svg"/);
  const image = new HTMLImageElement('/assets/product-1.svg');
  listeners.error({ target: image });
  assert.equal(image.src, '/assets/product-1.svg');
  assert.equal(image.dataset.coverFallback, undefined);
});

test('site name and active navigation are updated without duplicating the default name', async () => {
  const { store, document, nodes } = makeStore({
    config: { siteName: '特别$&商店' },
    auth: { authenticated: true, user: { email: 'hello@example.com' } },
  });
  const name = { textContent: '' };
  const nav = {
    dataset: { nav: 'shop' },
    classList: { toggle: (name, value) => { nav.active = value; } },
    setAttribute: (name, value) => { nav[name] = value; },
    removeAttribute: name => { delete nav[name]; },
  };
  const label = { textContent: '' };
  const dot = { textContent: '' };
  nodes['[data-site-name]'] = [name];
  nodes['[data-nav]'] = [nav];
  nodes['[data-account-label]'] = [label];
  nodes['[data-account-dot]'] = [dot];
  await store.initChrome('shop');
  assert.equal(document.title, '全部商品 · 特别$&商店');
  assert.equal(name.textContent, '特别$&商店');
  assert.equal(nav.active, true);
  assert.equal(nav['aria-current'], 'page');
  assert.equal(label.textContent, '个人中心');
  assert.equal(dot.textContent, 'H');
});

test('inline scripts in all pages parse successfully', async () => {
  for (const name of ['index.html', 'shop.html', 'account.html', 'admin.html']) {
    const html = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    for (const [, code] of scripts) if (code.trim()) assert.doesNotThrow(() => new vm.Script(code, { filename: name }));
  }
});
