import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/product.html', import.meta.url), 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');

function makeNode() {
  const classes = new Set();
  const listeners = {};
  return {
    textContent: '', innerHTML: '', disabled: false, dataset: {}, open: false, title: '',
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle: (name, value) => (value ? classes.add(name) : classes.delete(name)),
    },
    classes,
    setAttribute() {}, removeAttribute() {}, focus() {}, querySelector: () => makeNode(),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    listeners,
  };
}

function makePage({ product, authenticated }) {
  const nodes = new Map(), calls = [], toasts = [];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, makeNode());
    return nodes.get(selector);
  };
  const store = {
    $: node,
    $$: () => [],
    esc: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    api: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === '/api/products/prd_test') return { product };
      if (path === '/api/categories') return { items: [{ id: 'cat_one', name: '设计素材' }] };
      if (path === '/api/products?category=cat_one') return { items: [] };
      if (path === '/api/auth/me') return authenticated ? { authenticated: true, user: { id: 'usr_1', email: 'a@b.test' } } : { authenticated: false };
      if (path === '/api/config') return { siteName: '测试商店' };
      if (path === '/api/access') return { total_points: 100 };
      if (path === '/api/library') return { owned_product_ids: [], subscriptions: [] };
      return {};
    },
    toast: message => toasts.push(message),
    withBusy: (button, task) => task(),
    setModal: () => {},
    initChrome: async () => {
      calls.push({ path: '/api/auth/me' });
      return { me: authenticated ? { id: 'usr_1', email: 'a@b.test' } : null };
    },
    productCover: () => '<div class="product-cover"></div>',
    productHref: id => '/product?id=' + encodeURIComponent(id),
    purchaseHint: error => ({ message: error.message, action: null }),
    setPoints: () => {},
    deliveryHtml: () => '<div class="delivery-block">TEXT</div>',
    catalogTreeHtml: () => '<div class="tree-empty">暂无目录</div>',
    query: () => new URLSearchParams('id=prd_test'),
  };
  const context = vm.createContext({
    Store: store,
    document: { title: '', body: { classList: { add() {}, remove() {} } } },
    window: {}, location: { href: '', pathname: '/product', search: '?id=prd_test' },
    URLSearchParams, crypto: globalThis.crypto, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, Date, console,
  });
  vm.runInContext(inline, context);
  return { context, nodes, calls, toasts, node };
}

const product = {
  id: 'prd_test', title: '极简模板包', summary: '一套模板', description: '第一行\n第二行 <script>',
  price_points: 30, cover_url: '', category_id: 'cat_one', tags: ['设计', '模板'],
  preview_files: ['资料/'], preview_truncated: false, product_kind: 'SINGLE',
  allow_repeat: false, subscription_days: 0, update_frequency: 'IRREGULAR',
  delivery_type: 'TEXT', delivery_label: '文本内容', stock: 3,
};

test('product detail page renders escaped copy, price, tags and delivery notes', async () => {
  const page = makePage({ product, authenticated: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(page.node('#heroTitle').textContent, '极简模板包');
  assert.equal(page.node('#heroSummary').textContent, '一套模板');
  assert.equal(page.context.document.title, '极简模板包 · 云端积分商店');
  assert.match(page.node('#heroPrice').innerHTML, /30/);
  assert.equal(page.node('#heroStock').textContent, '剩余 3 份');
  assert.equal(page.node('#heroCategory').textContent, '设计素材');
  assert.match(page.node('#heroTags').innerHTML, /href="\/shop\?tag=%E8%AE%BE%E8%AE%A1"/);
  // Newlines become breaks and markup is never interpreted.
  assert.match(page.node('#detailDesc').innerHTML, /第一行<br>第二行 &lt;script&gt;/);
  assert.match(page.node('#detailDelivery').textContent, /文本内容/);
  assert.equal(page.node('#catalogButton').classList.contains('hidden'), false);
  assert.match(page.node('#catalogMeta').textContent, /1 项/);
});

test('a visitor without a session is sent to the account page with a return path', async () => {
  const page = makePage({ product, authenticated: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  page.node('#buyButton').dataset.mode = 'buy';
  page.node('#buyButton').listeners.click({ currentTarget: page.node('#buyButton') });
  assert.equal(page.context.location.href, '/account?next=' + encodeURIComponent('/product?id=prd_test'));
});

test('signed-in visitors see the balance-driven button state', async () => {
  const page = makePage({ product, authenticated: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(page.node('#buyButton').textContent, '立即兑换 ↗');
  assert.equal(page.node('#buyButton').disabled, false);
  assert.equal(page.node('#buyButton').dataset.mode, 'buy');
});

test('sold out products cannot be purchased and say so', async () => {
  const page = makePage({ product: { ...product, stock: 0 }, authenticated: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(page.node('#buyButton').textContent, '已售罄');
  assert.equal(page.node('#buyButton').disabled, true);
  assert.equal(page.node('#heroStock').textContent, '已售罄');
});
