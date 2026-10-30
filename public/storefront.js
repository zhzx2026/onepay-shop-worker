(function () {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !(options.body instanceof FormData)) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
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
    if (!modal) return;
    if (open) {
      modal._lastFocus = document.activeElement;
      modal.classList.add('show');
      document.body.classList.add('modal-open');
      requestAnimationFrame(() => {
        const focusable = focusSelector ? modal.querySelector(focusSelector) : modal.querySelector('button, input, a');
        focusable?.focus({ preventScroll: true });
      });
    } else {
      modal.classList.remove('show');
      if (!$('.modal.show')) document.body.classList.remove('modal-open');
      if (modal._lastFocus?.isConnected) modal._lastFocus.focus({ preventScroll: true });
    }
  }

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = $$('.modal.show');
    if (open.length) setModal(open[open.length - 1], false);
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
    if (state.tag) list = list.filter(item => (item.tags || []).includes(state.tag));
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
    return `<div class="product-cover"><img src="${esc(source)}"${fallbackAttr} alt="" loading="lazy"><span class="cover-badge">${esc(product.delivery_label || '数字交付')}</span></div>`;
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
    if (delivery.type === 'TEXT') {
      return `<div class="delivery-block"><div class="delivery-label">交付文本</div>
        <pre class="text-output">${esc(delivery.text)}</pre>
        <button class="sbtn sm" style="margin-top:8px" data-copy="${esc(delivery.text)}">复制文本</button></div>`;
    }
    if (delivery.type === 'LINK') {
      return `<div class="delivery-block"><div class="delivery-label">交付链接</div>
        <div class="link-output"><a href="${esc(delivery.url)}" target="_blank" rel="noopener noreferrer">${esc(delivery.url)}</a>
        <button class="sbtn sm" data-copy="${esc(delivery.url)}">复制</button></div></div>`;
    }
    if (delivery.type === 'FILE' && delivery.file) {
      return `<div class="delivery-block"><div class="delivery-label">交付文件</div>
        <div class="link-output"><span>${esc(delivery.file.name)}</span>
        <a class="sbtn sm primary" href="${esc(delivery.file.download_path)}">下载文件</a></div></div>`;
    }
    return '';
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

  window.Store = { $, $$, esc, api, toast, withBusy, setModal, fmtTime, initChrome, categoryIds, filterProducts, productCover, setPoints, deliveryHtml, copyText, query };
})();
