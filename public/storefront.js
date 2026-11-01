(function () {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !(options.body instanceof FormData)) headers['content-type'] = 'application/json';
    const method = String(options.method || 'GET').toUpperCase();
    const publicRead = method === 'GET' && /^\/api\/(?:products|categories|config|product)(?:\?|$)/.test(path);
    const response = await fetch(path, { ...options, cache: publicRead ? (options.cache ?? 'default') : 'no-store', headers });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), { data, status: response.status });
    return data;
  }

  function toast(message) {
    let node = $('#toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'toast';
      node.className = 'toast';
      // Assistive technology announces every toast without stealing focus.
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('on');
    clearTimeout(node._timer);
    node._timer = setTimeout(() => node.classList.remove('on'), 3200);
  }

  async function withBusy(button, task) {
    if (!button) return task();
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    try { return await task(); }
    finally {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
    }
  }

  function setModal(target, open, focusSelector) {
    const modal = typeof target === 'string' ? $(target) : target;
    if (!modal || (!open && modal.getAttribute('aria-busy') === 'true')) return;
    if (open) {
      modal._lastFocus = document.activeElement;
      modal.classList.add('show');
      document.body.classList.add('modal-open');
      requestAnimationFrame(() => {
        if (!modal.classList.contains('show')) return;
        const focusable = focusSelector ? modal.querySelector(focusSelector) : modal.querySelector('button, input, a');
        focusable?.focus({ preventScroll: true });
      });
    } else {
      modal.classList.remove('show');
      if (typeof modal._onClose === 'function') modal._onClose();
      if (!$('.modal.show')) document.body.classList.remove('modal-open');
      if (modal._lastFocus?.isConnected) modal._lastFocus.focus({ preventScroll: true });
    }
  }

  document.addEventListener('keydown', event => {
    const open = $$('.modal.show');
    const modal = open[open.length - 1];
    if (!modal) return;
    if (event.key === 'Escape') { event.preventDefault(); setModal(modal, false); return; }
    if (event.key !== 'Tab') return;
    const focusable = $$('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])', modal)
      .filter(node => node.getClientRects().length);
    if (!focusable.length) {
      event.preventDefault(); modal.setAttribute('tabindex', '-1'); modal.focus({ preventScroll: true }); return;
    }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });

  function fmtTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
  }

  async function initChrome(active = '') {
    const [configResult, authResult] = await Promise.allSettled([api('/api/config'), api('/api/auth/me')]);
    const config = configResult.status === 'fulfilled' ? configResult.value : {};
    const auth = authResult.status === 'fulfilled' ? authResult.value : {};
    const me = auth.authenticated ? auth.user : null;
    if (config.siteName) {
      $$('[data-site-name]').forEach(node => { node.textContent = config.siteName; });
      document.title = document.title.replace(/云端积分商店|积分商店/g, () => config.siteName);
    }
    if (config.description) $$('[data-site-description]').forEach(node => { node.textContent = config.description; });
    $$('[data-nav]').forEach(node => {
      const selected = node.dataset.nav === active;
      node.classList.toggle('active', selected);
      if (selected) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    $$('[data-account-label]').forEach(node => { node.textContent = me ? '个人中心' : '登录 / 注册'; });
    $$('[data-account-dot]').forEach(node => { node.textContent = me ? (me.email || 'U').slice(0, 1).toUpperCase() : '→'; });
    return { config, me };
  }

  function categoryIds(id, categories) {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      categories.filter(item => item.parent_id === ids[i]).forEach(item => {
        if (!ids.includes(item.id)) ids.push(item.id);
      });
    }
    return ids;
  }

  function filterProducts(products, categories, state) {
    let list = products.slice();
    if (state.category) {
      const ids = new Set(categoryIds(state.category, categories));
      list = list.filter(item => ids.has(item.category_id));
    }
    const tags = Array.isArray(state.tags) ? state.tags : (state.tag ? [state.tag] : []);
    if (tags.length) list = list.filter(item => tags.every(tag => (item.tags || []).includes(tag)));
    if (state.q) {
      const q = state.q.toLowerCase();
      list = list.filter(item => [item.title, item.summary, ...(item.tags || [])].join(' ').toLowerCase().includes(q));
    }
    if (state.sort === 'price-asc') list.sort((a, b) => Number(a.price_points) - Number(b.price_points));
    if (state.sort === 'price-desc') list.sort((a, b) => Number(b.price_points) - Number(a.price_points));
    if (state.sort === 'newest') list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return list;
  }

  function productCover(product, index = 0) {
    const hash = Array.from(String(product.id || '')).reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
    const art = product.id ? hash % 4 : Math.abs(index) % 4;
    const fallback = `/assets/product-${art + 1}.svg`;
    const source = product.cover_url || fallback;
    const fallbackAttr = product.cover_url ? ` data-cover-fallback="${fallback}"` : '';
    const provider = product.provider?.id === 'quark' ? { icon: '/assets/netdisk-quark.png', label: '夸克网盘' }
      : product.provider?.id === 'baidu' ? { icon: '/assets/netdisk-baidu.png', label: '百度网盘' } : null;
    const badge = provider ? `<img src="${provider.icon}" alt="">${provider.label}` : esc(product.delivery_label || '数字交付');
    return `<div class="product-cover"><img src="${esc(source)}"${fallbackAttr} alt="" loading="lazy"><span class="cover-badge">${badge}</span></div>`;
  }

  document.addEventListener('error', event => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.dataset.coverFallback) {
      image.src = image.dataset.coverFallback;
      delete image.dataset.coverFallback;
    }
  }, true);

  function setPoints(points) {
    const valid = points !== null && points !== undefined && Number.isFinite(Number(points));
    $$('[data-points-wrap]').forEach(node => node.classList.toggle('hidden', !valid));
    if (valid) $$('[data-points]').forEach(node => { node.textContent = Number(points); });
  }

  function deliveryHtml(delivery) {
    if (!delivery) return '';
    if (delivery.type === 'SUBSCRIPTION') {
      return `<div class="delivery-block subscription-delivery"><div class="delivery-symbol" aria-hidden="true">↻</div><div><b>订阅权益已记录</b><p>前往「我的订阅」查看系列更新与有效期。</p><a class="sbtn sm primary" href="/account?tab=subscriptions&product=${encodeURIComponent(delivery.product_id || '')}">查看我的订阅 <span aria-hidden="true">↗</span></a></div></div>`;
    }
    if (delivery.type === 'TEXT') {
      return `<div class="delivery-block"><div class="delivery-label"><span aria-hidden="true">✧</span> 交付文本</div>
        <pre class="text-output">${esc(delivery.text)}</pre>
        <button class="sbtn sm soft delivery-copy" data-copy="${esc(delivery.text)}">复制文本</button></div>`;
    }
    if (delivery.type === 'LINK') {
      return `<div class="delivery-block"><div class="delivery-label"><span aria-hidden="true">↗</span> 交付链接</div>
        <div class="link-output"><a class="delivery-url" href="${esc(delivery.url)}" target="_blank" rel="noopener noreferrer">${esc(delivery.url)}</a>
        <button class="sbtn sm soft" data-copy="${esc(delivery.url)}">复制链接</button></div></div>`;
    }
    if (delivery.type === 'FILE' && delivery.file) {
      return `<div class="delivery-block"><div class="delivery-label"><span aria-hidden="true">↓</span> 交付文件</div>
        <div class="link-output file-output"><span class="file-icon" aria-hidden="true">▤</span><span class="file-name">${esc(delivery.file.name)}</span>
        <a class="sbtn sm primary" href="${esc(delivery.file.download_path)}">下载文件 ↓</a></div></div>`;
    }
    return '';
  }

  // The server sends only reviewed names. Implicit folders are reconstructed
  // from paths; filenames are escaped and never interpreted as markup.
  function catalogTreeHtml(paths) {
    const root = { children: new Map() };
    for (const raw of Array.isArray(paths) ? paths : []) {
      if (typeof raw !== 'string') continue;
      const folder = raw.endsWith('/');
      const parts = raw.split('/').filter(Boolean);
      let parent = root;
      parts.forEach((name, index) => {
        const isFolder = index < parts.length - 1 || folder;
        const key = (isFolder ? 'd:' : 'f:') + name;
        if (!parent.children.has(key)) parent.children.set(key, { name, folder: isFolder, children: new Map() });
        parent = parent.children.get(key);
      });
    }
    const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/></svg>';
    const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h6"/></svg>';
    const render = node => [...node.children.values()].map(item => item.folder
      ? `<details class="tree-folder"><summary><span class="tree-chevron" aria-hidden="true">›</span><span class="tree-icon">${folderIcon}</span><span class="tree-name">${esc(item.name)}</span><small>${item.children.size ? item.children.size + ' 项' : ''}</small></summary><div class="tree-children">${item.children.size ? render(item) : '<div class="tree-empty">暂无可展示的子项</div>'}</div></details>`
      : `<div class="tree-file"><span class="tree-spacer"></span><span class="tree-icon">${fileIcon}</span><span class="tree-name">${esc(item.name)}</span></div>`).join('');
    return render(root) || '<div class="tree-empty">暂无目录</div>';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      toast('复制失败，请手动选择文本');
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    copyText(button.dataset.copy || '');
  });

  function query() {
    return new URLSearchParams(location.search);
  }

  window.Store = { $, $$, esc, api, toast, withBusy, setModal, fmtTime, initChrome, categoryIds, filterProducts, productCover, setPoints, deliveryHtml, catalogTreeHtml, copyText, query };
})();
