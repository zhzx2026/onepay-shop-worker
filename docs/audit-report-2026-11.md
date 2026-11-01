# 全项目体检报告 · onepay-shop-worker

> 体检日期：2026-11-01　｜　基线提交：`acf5e56`（main）　｜　体检人：Arena Agent
> 范围：`src/*.js`、`public/*.html|css|js`、`migrations/*.sql`、`tests/*.js`、`README.md`、`docs/*`
> 方法：逐文件通读 + 在本地 `wrangler dev`（本地 D1 / R2）跑通注册、登录、管理员、分类、商品、兑换、订阅、订单同步、缓存响应头等真实链路 + `npm test`（112 项全部通过）
> 第二轮（同日晚间）：继续修复 P2 项并补回归测试，见第十一节

---

## 一、总体结论

| 维度 | 评价 | 说明 |
| --- | --- | --- |
| 业务逻辑 | **A-** | 积分两本账、幂等、租约、原子事务、只在对账通过时交付，这块做得比绝大多数同类项目扎实 |
| 安全 | **B+** | 独立后台会话、PBKDF2、Origin 校验、Cookie HttpOnly/Secure/SameSite、审计日志都有；**但登录/注册完全没有限流**，属于明显缺口 |
| 前台 UI | **B** | 视觉完成度高、留白与排版讲究；**缺商品详情层**，导致后台精心填写的「商品详情」字段前台无处展示 |
| 后台 UI | **B+** | 结构清晰、有原数据查看、有进度条与配对流程；列表类页面缺分页/筛选 |
| 交互细节 | **B** | 加载态、禁用态、空状态、错误态大体齐全；少数按钮点了没有反馈，余额与剩余积分提示不足 |
| 可访问性 | **B** | 有 focus-visible、Tab 焦点陷阱、Esc 关闭、role/aria；toast 无 aria-live、部分图标按钮缺提示 |
| 工程与文档 | **A-** | README 极详尽、测试覆盖关键不变量、缓存策略有版本号纪律；文档与新功能需要同步 |

**一句话结论**：这是一个完成度已经很高的项目，主要问题不是"能不能用"，而是**三个"说不清"** —— 用户在购买前说不清商品里有什么（详情字段无处显示）、出错时说不清发生了什么（部分接口返回空 body、错误提示弱）、运营者说不清是谁在猛刷（登录无限流）。此外还有一批一致性、分页、可访问性的小坑。

---

## 二、P0 · 必须修复（会造成误解或安全缺口）

### P0-1　`/api/access` 不返回 `used`，个人中心「已使用积分」永远显示 `10 + ?`
- **位置**：`src/index.js:989-1003`；`public/account.html:272`
- **现象**：接口只返回 `bonus_points / bonus_used / onepay_points / total_points`，前端却判断 `Number.isFinite(data.used)`。本机实测：兑换 10 积分后返回
  `{"bonus_points":10,"bonus_used":10,"onepay_points":null,...}` —— 没有 `used` 字段。
- **影响**：个人中心统计卡显示 `10 + ?`，用户会怀疑有隐藏扣费；这是**数字型误导**，优先级最高。
- **修复**：服务端补充 `used_points`（已交付订单的 `SUM(price_points)`）并保留 `used` 别名；前端改为读取 `used_points`，降级时显示 `—` 而不是 `?`。

### P0-2　未知 `/api/*` 路径返回空 404（被静态资源接管）
- **位置**：`src/index.js:1480-1490`（`fetch()` 中 `route()` 返回 null 后直接走 `env.ASSETS`）
- **现象**：`GET /api/nope` → `404`，**body 为空**、无 `content-type`。
- **影响**：前端 `api()` 会 `try { await response.json() } catch {}` 得到 `{}`，最终提示"请求失败"，无法定位是路径写错还是权限问题；第三方 Agent 对接也会一脸问号。
- **修复**：`route()` 返回 null 后，若路径以 `/api/` 开头，统一返回 JSON `404 NOT_FOUND`。

### P0-3　注册失败时把数据库原始错误回传给浏览器
- **位置**：`src/index.js:950`
- **现象**：`return fail(500, \`注册失败：${e.message}\`, ...)`，会把 SQLite/D1 的驱动错误、表名、约束名直接吐到前端。
- **影响**：信息泄露（schema 结构、驱动版本），且对普通用户毫无意义。
- **修复**：统一返回"注册失败，请稍后重试"；细节只写 `console.error`。

### P0-4　登录 / 注册没有任何频率限制
- **位置**：`src/index.js:944-980`（`/api/auth/register`、`/api/auth/login`、`/api/admin/login`）
- **现象**：Agent 配对接口每 IP 5 分钟 5 次、全局 100 次，**而密码登录接口一次都不限**。
- **影响**：可无限撞库（尤其管理员账号与前台同库）、可脚本批量注册灌水；PBKDF2 100k 还意味着每次尝试都会消耗 Worker CPU，等于给攻击者一个廉价的放大攻击面。
- **修复**：新增 `auth_limits` 表（迁移 `0010_auth_limits.sql`），按 **IP**（20 次/5 分钟）与 **邮箱**（8 次/5 分钟）双维度计数，成功登录后清空该邮箱计数；**表不存在时自动降级为不限流**（避免老数据库升级时把人锁在门外），超限返回 `429 + Retry-After`。

---

## 三、P1 · 应该修复（功能缺失与一致性）

### P1-5　「商品详情」字段前台无处可见
- **位置**：`public/shop.html`（商品卡结构与弹窗集合）、`public/admin.html`（`pDesc` 编辑框）
- **现象**：后台可以填写最多 4000 字的商品详情，接口也一直在返回 `description`，但前台**没有任何地方渲染它**。
- **影响**：用户只能看到一个标题 + 一行副标题就要花积分，决策信息严重不足；后台运营者以为"写了就有用"。
- **修复**：新增**商品详情弹窗**（封面、分类、标签、详情正文、系列规则、资源目录入口、价格、兑换按钮），并支持 `?product=<id>` 深链直达。

### P1-6　首页推荐卡片用「关键词搜索」伪装详情页
- **位置**：`public/index.html:139` —— `href="/shop?q=${encodeURIComponent(product.title)}"`
- **影响**：标题含空格/符号时可能搜不到（本地实测 `Pro 模板包` 可以，但 `A+B 模板` 类标题就会漏），且落地后是"搜索结果页"而不是商品，用户还要再点一次。
- **修复**：改为 `/shop?product=<id>`，商品页直接弹出详情。

### P1-7　排序不写进 URL
- **位置**：`public/shop.html:417-419`、`syncUrl()`
- **影响**：选了"积分从低到高"后刷新/分享/后退全部丢失，`state.sort` 也不会从 URL 初始化。
- **修复**：`sort` 参与 URL 同步与初始化（`recommended` 时省略参数保持链接干净）。

### P1-8　顶栏搜索图标在商品页点了没反应
- **位置**：`public/shop.html:26`（`href="/shop"`，而当前页就是 `/shop`）
- **影响**：典型的"死按钮"，用户会以为站点卡住。
- **修复**：商品页点击后展开筛选面板并聚焦搜索框（`preventDefault` + `focus`）；其它页面维持跳转。

### P1-9　顶栏积分提示只在部分页面出现
- **位置**：`public/index.html`（未调用 `/api/access`）、`public/shop.html`、`public/account.html`
- **影响**：已登录用户在首页看不到积分，进商品页才出现 —— 同一用户的头部信息在站点内跳变。
- **修复**：首页在已登录时也加载余额（失败静默，不影响渲染）。

### P1-10　兑换确认弹窗不告诉用户"兑换后还剩多少"
- **位置**：`public/shop.html` 购买弹窗（`purchaseTerms`）
- **影响**：积分余额接近价格时，用户只能盲点；不足时也只弹一个 toast 再跳转。
- **修复**：弹窗内显示"当前 X 积分 · 兑换后剩余 Y"，不足时直接显示警示行并禁用确认按钮（服务端仍为最终校验）。

### P1-11　后台「成交订单」固定 50 条，无分页无筛选
- **位置**：`src/index.js:1235`、`public/admin.html` `loadOrders()`
- **影响**：订单多了以后看不到历史；无法只查"待确认"订单。
- **修复**：接口支持 `offset` 与 `status`，返回 `has_more/next_offset`；后台加状态筛选与"加载更多"。

### P1-12　后台「用户管理」接口支持 offset，但界面没有翻页
- **位置**：`public/admin.html` `loadUsers()` / `renderUsers()`
- **影响**：超过 20 个账号后只能在搜索框里找，运营体验断崖。
- **修复**：增加上一页/下一页（带页码与总数）。

### P1-13　`processOrder` 的 `catch` 吞掉所有异常
- **位置**：`src/index.js:567`
- **影响**：任何真实代码缺陷（字段改名、`undefined` 调用）都会被伪装成"扣减状态未知，请稍后同步"，日志里一片空白，线上排查几乎不可能。
- **修复**：`catch (error)` 写 `console.error('order_process_failed', key, error && error.message)`（不含凭证）。

### P1-14　过期会话从不清理
- **位置**：`src/index.js` `createSession()`
- **影响**：`sessions` 表只增不减（14 天 TTL 到期后仍是死数据）。
- **修复**：`createSession()` 时顺带 `DELETE FROM sessions WHERE expires_at < now`。

### P1-15　复制文本只有 `navigator.clipboard` 一条路
- **位置**：`public/storefront.js` `copyText()`
- **影响**：非安全上下文（内嵌浏览器、部分 App WebView）会直接失败，只留一句"请手动选择文本"，但页面上并没有可选的输入框。
- **修复**：回退到隐藏 `textarea + document.execCommand('copy')`，成功给出同样提示。

### P1-16　toast 没有 `role="status"` / `aria-live`
- **位置**：`public/storefront.js`、`public/admin.html` 的 `toast()`
- **影响**：读屏用户完全听不到"已复制""兑换成功""积分不足"等关键反馈。
- **修复**：创建节点时补 `role="status" aria-live="polite"`（后台静态节点同样补齐）。

---

## 四、P2 · 体验与细节（本次部分修复 / 建议排期）

| 编号 | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| P2-17 | 商品列表一次最多 200 条，且**筛选在前端做**；超过 200 条后搜索静默漏结果 | `src/index.js` `listProducts`、`public/shop.html` | 中期改为服务端筛选（接口已支持 `q/category/tag`），前端只做渲染；或返回 `truncated` 标记提示用户 |
| P2-18 | `/api/products` 每个商品都带完整 `description`（≤4000 字），列表载荷偏大 | `publicProduct()` | 拆分详情接口或在列表中截断，详情弹窗再取全量 |
| P2-19 | 商品已售罄时，卡片同时出现"已售罄"按钮与"剩余 0"文案 | `public/shop.html` | 库存行改为"暂时售罄，等待补货" |
| P2-20 | ~~无 404 页面、无 `robots.txt`~~ | 静态资源 | ✅ **已修复**：`public/404.html`（品牌化空状态 + 回商品页）与 `public/robots.txt`；页面 404 返回该文件且 `no-store` |
| P2-21 | 大文件下载不支持Range/断点续传 | `downloadOrderFile()` | 如需支持，可解析 `Range` 头并返回 `206` |
| P2-22 | ~~后台上下架用"整行对象 PUT"~~ | `public/admin.html` `toggleGoods()` | ✅ **已修复**：新增 `POST /api/admin/products/:id/status`，只改状态字段并失效目录缓存 |
| P2-23 | 文件上传无进度条（只有"正在上传…"toast） | `public/admin.html` `uploadFile()` | 换用 `XMLHttpRequest` 的 `upload.onprogress` |
| P2-24 | `sessions`/`consumption_jobs`/`purchase_intents` 无定期归档策略 | 数据层 | 定期清理，或加管理员"数据维护"面板 |
| P2-25 | 后台列表在超宽/超窄屏下表头与行对齐依赖 `data-label` | `public/admin.css` | 已在 600px 断点处理，可接受 |
| P2-26 | ~~订阅到期无"即将到期"提醒~~ | `account.html` | ✅ **已修复**：有效期 ≤7 天时状态标签变"还剩 N 天"，续订按钮改为直达 `/shop?product=<id>` |

---

## 五、安全与合规观察（除 P0 外）

| 项 | 现状 | 评价 |
| --- | --- | --- |
| 会话隔离 | 前台 `onepay_session` / 后台 `onepay_admin_session` 分离，后台每次请求重查角色 | 良好 |
| Cookie | `HttpOnly; Secure; SameSite=Lax; Path=/` | 良好（可考虑 `__Host-` 前缀加固） |
| CSRF | 非 GET 校验 `Origin`；SameSite=Lax 双保险 | 良好 |
| 密码 | PBKDF2-SHA256 100000 次（Workers 上限），无明文 | 良好 |
| 越权 | `user_id` 取自已认证会话；文件下载校验订单归属；Agent 令牌仅能建草稿 | 良好 |
| 通知签名 | HMAC + 时间戳 ±300s + 事件去重 | 良好 |
| 限流 | 登录 / 注册 / 管理员登录按 IP 与邮箱双维度计数（`0010`），Agent 配对另有独立限流 | ✅ 已补齐 |
| 响应头 | `X-Content-Type-Options: nosniff` + `Referrer-Policy: strict-origin-when-cross-origin`（全站统一） | 良好；`X-Frame-Options` 仍不加，避免破坏预览内嵌 |
| 日志 | 订单处理异常写 `order_process_failed`（仅订单号与错误信息，无凭据）；注册失败原因只落服务端 | ✅ 已修复 |
| 密钥存储 | D1 `settings` 优先、Secret 兜底，只回传掩码 | 良好 |

---

## 六、性能与缓存

- ✅ 缓存策略设计正确：公开 JSON 走 Cache API + 代际失效（generation key），私有接口一律 `no-store`，HTML 外壳短缓存，带 `?v=` 的静态资源长缓存。本机实测响应头符合 README 描述。
- ✅ 变更类接口会在同一数据中心失效 `catalog` / `site` / `plans` 代际，不会出现"库存已变但列表仍是旧数据"的错觉（兑换后前端还会强制刷新）。
- ⚠️ `/api/access` 每次都要打 2 次上游（`/capabilities` + `/access`），商品页与个人中心各调一次 → 单次页面浏览最多 4 次上游请求。建议对 `/capabilities` 做 60 秒隔离级缓存（需注意测试隔离，故本次未改，列入后续）。
- ⚠️ 商品列表 200 条硬上限 + 前端筛选（见 P2-17）。

---

## 七、可访问性（A11y）

- ✅ 已有：`focus-visible` 轮廓、模态焦点陷阱与恢复、`Esc` 关闭、`aria-selected/aria-expanded/aria-current`、图标按钮带 `aria-label`、`prefers-reduced-motion`。
- ⚠️ 待改：toast 无 `aria-live`（P1-16）；商品卡标题是纯文本，不是可聚焦的"查看详情"入口（随 P1-5 一并解决）；部分"↗ / ✳ / ✧"装饰符仅用 `aria-hidden` 包裹，读屏语义正确。
- 个人中心 Tab 采用 roving tabindex（左右方向键切换）符合 WAI-ARIA 规范，**无需改动**。

---

## 八、文档一致性

- README 体量大、质量高，但需同步本次变更：`/api/access` 新字段、登录限流与迁移 `0010`、商品详情弹窗与 `?product=` / `sort` URL 参数、后台订单分页。
- README "升级已有数据库" 一节需要加上 `0010_auth_limits.sql`，否则新代码在旧库上会走降级路径（功能可用，但没有限流保护）。

---

## 九、本次修复清单（执行状态）

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| P0-1 | `/api/access` 增加 `used_points`；个人中心正确显示已用积分 | ✅ 已修复 |
| P0-2 | `/api/*` 未知路径返回 JSON 404 | ✅ 已修复 |
| P0-3 | 注册失败不再回传数据库原始错误 | ✅ 已修复 |
| P0-4 | 登录/注册限流（新迁移 `0010`，缺表自动降级） | ✅ 已修复 |
| P1-5 | 商品详情弹窗 + `?product=` 深链 | ✅ 已修复 |
| P1-6 | 首页卡片直达商品详情 | ✅ 已修复 |
| P1-7 | 排序写入 URL 并可恢复 | ✅ 已修复 |
| P1-8 | 商品页顶栏搜索聚焦输入框 | ✅ 已修复 |
| P1-9 | 首页顶栏显示积分 | ✅ 已修复 |
| P1-10 | 兑换弹窗显示兑换后余额 / 不足警示 | ✅ 已修复 |
| P1-11 | 后台订单分页 + 状态筛选 | ✅ 已修复 |
| P1-12 | 后台用户分页 | ✅ 已修复 |
| P1-13 | 订单处理异常写日志 | ✅ 已修复 |
| P1-14 | 登录时清理过期会话 | ✅ 已修复 |
| P1-15 | 复制文本回退方案 | ✅ 已修复 |
| P1-16 | toast 加 `role="status"` / `aria-live` | ✅ 已修复 |
| P2-19 | 售罄文案去重 | ✅ 已修复 |
| P2-20 | 品牌化 404 页面 + `robots.txt` | ✅ 已修复 |
| P2-22 | 商品上下架专用端点，不再整行 PUT | ✅ 已修复 |
| P2-26 | 订阅剩余天数与续订提醒 | ✅ 已修复 |
| P2-17/18/21/23/24 | 见上表，本次未改（已列入后续排期） | ⏳ 待排期 |

---

## 十、回归风险与验证方式

- 新增迁移 `0010_auth_limits.sql` **对老库是向后兼容的**：代码在 `catch` 中降级，未迁移时登录仍可用，只是没有限流。
- 前端只增不改：详情弹窗为新增 DOM 与函数，原有兑换、目录、订阅链路保持不变。
- 静态资源版本号统一升到 `20261101-2`（三个前台页面保持一致），后台样式为 `20261101-4`，避免浏览器继续使用旧 CSS/JS。
- 验证：`npm test`（现有 101 项 + 新增用例）全部通过；`wrangler dev` 本地跑通注册 → 管理员 → 建分类/商品 → 兑换 → 订阅 → 续订 → 订单同步 → 限流触发 → 404 JSON 等链路。

---

## 十一、第二轮修复（补充）

第一轮把 P0 / 主要 P1 修完后，又做了一轮以"按钮真的能用、错误真的看得懂"为目标的收尾。

| 编号 | 内容 | 位置 | 说明 |
| --- | --- | --- | --- |
| N-1 | 后台彻底弃用原生 `confirm()` / `prompt()` | `public/admin.html`、`public/admin.css` | 新增 `askConfirm()` / `askPassword()` 弹窗：带标题、说明、危险色确认键、`Esc` / 遮罩 / 取消按钮关闭、Tab 焦点陷阱与 `aria-modal`。原生弹窗在 iframe 预览、部分 App WebView 中会被静默拦截；`prompt()` 还会把新密码明文显示在地址栏旁的系统对话框里。共替换 13 处 |
| N-2 | 客户密码重置不再明文输入 | `public/admin.html` `resetPassword()` | 改为 `type=password` + 前端 ≥10 位校验 + 服务端 PBKDF2，错误只在弹窗内提示，不写日志 |
| N-3 | 密钥一次性展示加"复制 / 自动清除" | `public/admin.html` `showSecret()` | 手写 `copySecret()` 回退（`execCommand`），2 分钟后自动清空 DOM，离开页面即不可再见；`role="status" aria-live="polite"` |
| N-4 | 后台商品搜索支持输入即筛选 | `public/admin.html` | 350ms 防抖，回车 / 搜索按钮仍立即触发；避免逐字敲击打满后台接口 |
| N-5 | `/api/orders` 返回生命周期汇总 | `src/index.js` | 新增 `totals.total / delivered / pending`，个人中心"已购记录"不再只数当前页（原来最多显示 50） |
| N-6 | 兼容非安全上下文的 UUID | `public/storefront.js`、`public/admin.html` | `Store.uuid()` / 本地 `uuid()`：优先 `crypto.randomUUID()`，降级 `getRandomValues` 手写 v4。局域网 http 预览下下单幂等键不再抛 `TypeError` |
| N-7 | 品牌化 404 + `robots.txt` | `public/404.html`、`public/robots.txt`、`src/index.js` | 浏览器 404 返回可跳回商品页的页面并 `no-store`；API 仍返回 JSON |
| N-8 | 商品上下架专用端点 | `src/index.js`、`public/admin.html` | `POST /api/admin/products/:id/status`：一次只改状态，避免并发编辑时整行覆盖库存 / 目录 / 交付内容 |
| N-9 | 全站安全响应头补齐 | `src/index.js` `withSecurityHeaders()` | 所有响应统一 `x-content-type-options: nosniff` + `referrer-policy: strict-origin-when-cross-origin`（之前只有 JSON 接口带 nosniff） |
| N-10 | 订阅剩余天数 | `public/account.html` | `≤7 天` 显示"还剩 N 天"并使用警示色；续订链接从"按标题搜索"改为 `?product=<id>` 直达详情 |
| N-11 | 详情弹窗与目录弹窗的层叠顺序 | `public/shop.html` | 详情弹窗调至目录弹窗之前，从详情打开资源目录时目录盖在上方，关闭后仍回到详情 |
| N-12 | 回归测试 | `tests/audit-fixes.test.js`（新增）、`tests/admin-users.test.js`、`tests/cache.test.js` | 覆盖：`used_points`、JSON 404、订单分页 / 状态筛选 / `totals`、按 IP 与邮箱的限流（含未迁移时的降级）、注册错误不外泄、商品状态端点、HTML 404、后台无原生弹窗、UUID 降级。共 **112 项全部通过** |

### 本轮仍未做（有意留白）

- **P2-17** 商品列表 200 条上限 + 前端筛选：需要服务端分页或 `truncated` 提示，属于数据量增长后的改造，改前应先确定商品上限策略。
- **P2-18** 列表携带完整 `description`：拆详情接口会改动前端取数链路，建议与 P2-17 一并做。
- **P2-21** 下载 `Range` 支持：R2 已支持，但需要处理 `206 / Content-Range / If-Range` 与签名校验，风险高于收益。
- **P2-23** 上传进度条：`fetch` 无上传进度事件，需换 `XMLHttpRequest`，收益有限。
- **P2-24** 历史数据归档：涉及数据保留策略与合规，应由运营决定保留期。
- **边缘缓存失效的作用域**：Cloudflare Cache API 按数据中心隔离，跨区域失效只能靠短 TTL（当前公开 JSON 30–60s），这是平台限制，已在 README 说明。
