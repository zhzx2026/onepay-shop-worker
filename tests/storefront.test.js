import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../public/storefront.js', import.meta.url), 'utf8');

function makeStore({ config = {}, auth = {} } = {}) {
  const listeners = {};
  const nodes = {};
  const requests = [];
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
    FormData,
    HTMLImageElement,
    requestAnimationFrame: callback => callback(),
    fetch: async (path, options) => {
      requests.push({ path, options });
      return { ok: true, json: async () => path === '/api/config' ? config : auth };
    },
  });
  vm.runInContext(script, context);
  return { store: context.window.Store, document, nodes, listeners, requests, HTMLImageElement };
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
  for (const name of ['index.html', 'shop.html', 'account.html', 'product.html', '404.html', 'admin.html']) {
    const html = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    for (const [, code] of scripts) if (code.trim()) assert.doesNotThrow(() => new vm.Script(code, { filename: name }));
  }
});


test('only public GET requests use the browser cache and explicit refresh bypasses it', async () => {
  const { store, requests } = makeStore();
  await store.api('/api/products?category=design');
  await store.api('/api/categories');
  await store.api('/api/auth/me');
  await store.api('/api/orders', { cache: 'force-cache' });
  await store.api('/api/products', { cache: 'no-store' });
  await store.api('/api/products/one/purchase', { method: 'POST', body: '{}' });
  await store.api('/api/products/prd_abc');
  assert.deepEqual(requests.map(item => item.options.cache), ['default', 'default', 'no-store', 'no-store', 'no-store', 'no-store', 'default']);
});

test('storefront pages use matching versioned CSS and JavaScript assets', async () => {
  let version;
  for (const name of ['index.html', 'shop.html', 'account.html', 'product.html', '404.html']) {
    const html = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    const cssVersion = html.match(/href="\/storefront\.css\?v=([^"]+)"/)?.[1];
    const jsVersion = html.match(/src="\/storefront\.js\?v=([^"]+)"/)?.[1];
    assert.ok(cssVersion, `${name} should version its stylesheet`);
    assert.equal(cssVersion, jsVersion, `${name} should use matching asset versions`);
    version ||= cssVersion;
    assert.equal(cssVersion, version, 'all storefront pages should use the same version');
  }
});

test('multiple selected tags must all match and preserve legacy single-tag links', () => {
  const { store } = makeStore();
  const products = [
    { id: 'both', tags: ['设计', '模板'] },
    { id: 'design', tags: ['设计'] },
    { id: 'template', tags: ['模板'] },
  ];
  assert.deepEqual(Array.from(store.filterProducts(products, [], { tags: ['设计', '模板'] }), p => p.id), ['both']);
  assert.deepEqual(Array.from(store.filterProducts(products, [], { tag: '设计' }), p => p.id), ['both', 'design']);
});

test('public catalog renders escaped, expandable folders and individual filenames', () => {
  const { store } = makeStore();
  const html = store.catalogTreeHtml(['资料/', '资料/一层/文件.pdf', '资料/一层/<img onerror=alert(1)>.txt', '独立.txt']);
  assert.match(html, /<details class="tree-folder">/);
  assert.match(html, /文件\.pdf/);
  assert.match(html, /独立\.txt/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;\.txt/);
  assert.ok(!html.includes('<img onerror'));
  assert.ok(!html.includes('https://'));
});

test('subscription delivery links to the private account area without exposing content', () => {
  const { store } = makeStore();
  const html = store.deliveryHtml({ type: 'SUBSCRIPTION', product_id: 'prd_safe' });
  assert.match(html, /\/account\?tab=subscriptions&product=prd_safe/);
  assert.match(html, /我的订阅/);
});

test('modal focus is contained and restored, and an in-flight modal cannot close', async () => {
  const { store, document, nodes, listeners } = makeStore();
  const bodyClasses = new Set(), modalClasses = new Set();
  document.body = { classList: { add: x => bodyClasses.add(x), remove: x => bodyClasses.delete(x) } };
  const trigger = { isConnected: true, focus: () => { document.activeElement = trigger; } };
  const first = { getClientRects: () => [1], focus: () => { document.activeElement = first; } };
  const last = { getClientRects: () => [1], focus: () => { document.activeElement = last; } };
  let busy = false;
  const modal = {
    classList: { add: x => modalClasses.add(x), remove: x => modalClasses.delete(x), contains: x => modalClasses.has(x) },
    getAttribute: name => name === 'aria-busy' && busy ? 'true' : null,
    querySelector: () => last,
    querySelectorAll: () => busy ? [] : [first, last],
    setAttribute: () => {}, focus: () => { document.activeElement = modal; },
    contains: target => target === first || target === last || target === modal,
  };
  document.querySelector = selector => selector === '.modal.show' && modalClasses.has('show') ? modal : null;
  nodes['.modal.show'] = [modal]; document.activeElement = trigger;
  store.setModal(modal, true, '#confirm');
  assert.equal(document.activeElement, last); assert.ok(bodyClasses.has('modal-open'));
  let prevented = false;
  listeners.keydown({ key: 'Tab', preventDefault: () => { prevented = true; } });
  assert.ok(prevented); assert.equal(document.activeElement, first);
  listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault: () => {} });
  assert.equal(document.activeElement, last);
  busy = true; listeners.keydown({ key: 'Tab', preventDefault: () => {} });
  assert.equal(document.activeElement, modal);
  listeners.keydown({ key: 'Escape', preventDefault: () => {} });
  assert.ok(modalClasses.has('show'));
  busy = false; listeners.keydown({ key: 'Escape', preventDefault: () => {} });
  assert.ok(!modalClasses.has('show')); assert.ok(!bodyClasses.has('modal-open')); assert.equal(document.activeElement, trigger);
  const css = await readFile(new URL('../public/storefront.css', import.meta.url), 'utf8');
  assert.match(css, /\.modal\.show\s*\{[^}]*visibility:\s*visible[^}]*transition:[^}]*visibility\s+0s/);
});

test('catalog cards open the product detail page instead of a title search', async () => {
  const shop = await readFile(new URL('../public/shop.html', import.meta.url), 'utf8');
  const home = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const [name, page] of [['shop.html', shop], ['index.html', home]]) {
    assert.match(page, /href="\$\{esc\(productHref\((?:product|item)\.id\)\)\}"/, `${name} should link cards to /product?id=`);
    assert.doesNotMatch(page, /href="\/shop\?q=\$\{encodeURIComponent\(product\.title\)\}/, `${name} should not fall back to a title search`);
  }
  assert.match(shop, /class="product-title-link"/);
  assert.match(shop, /class="detail-link"/);
});

test('the personal centre shows lifetime spend and a self-service password form', async () => {
  const account = await readFile(new URL('../public/account.html', import.meta.url), 'utf8');
  assert.ok(!account.includes('data.used'), 'the API never returned `used`; the page must use spent_points');
  assert.match(account, /data\.spent_points/);
  assert.match(account, /data\.order_count/);
  assert.match(account, /id="passwordForm"/);
  assert.match(account, /\/api\/auth\/password/);
  assert.ok(!/onclick="buyPoints\(/.test(account), 'package buttons must not interpolate SKUs into inline handlers');
  assert.match(account, /data-sku="/);
});

test('administrator order list offers filters and paging wired to the API', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /id="orderQuery"/);
  assert.match(admin, /id="orderStatus"/);
  assert.match(admin, /id="ordersPrev"/);
  assert.match(admin, /id="ordersNext"/);
  assert.match(admin, /\/api\/admin\/orders\?' \+ params/);
});
