# OnePay Shop · Cloudflare Worker

一个基于 Cloudflare Workers + D1 的**积分制数字商品商店**与管理后台。

模型很直接：用户先用支付宝**充值积分**（收费方式走一人付的 QUOTA / 积分包），再用积分在货架上**兑换商品**；商品交付内容由管理员在后台配置，支持**文本**（卡密、提取码）、**链接**（网盘分享地址、R2 公开域名）和**文件**（上传到 Cloudflare R2，凭订单下载）。

项目复用一人付现有收费方式与服务端权益判断，不在商户站点自行定价或把「打开支付宝」误当成支付成功。

## 交付能力

### 前台

- **首页（`/`）**：品牌入口与分类导航，不再直接堆叠商品货架。
- **商品页（`/shop`）**：独立商品目录，支持按一级分类、二级子分类、标签、关键词筛选与积分排序；父分类自动包含其子分类商品。
- **个人中心（`/account`）**：注册 / 登录、积分余额、充值套餐、我的已购与账户信息。充值入口只放在个人中心。
- **积分充值**：只读加载一人付当前 `/product` 可售积分套餐，点击后拿 `purchase_url` 跳转支付宝；入口状态不等于支付成功。
- **积分兑换**：先使用店铺赠送积分；不足部分再用 `/consume` 幂等核销支付宝积分。涉及一人付时，**只有 `status=SUCCEEDED && confirmed=true` 才交付内容**；纯赠送积分订单无需请求一人付。
- **我的已购**：已购内容永久保存在 D1，可随时回来查看；文本可一键复制、链接可直接打开、文件走订单专属下载地址。
- 待确认订单可点「同步待确认订单」查询一人付 `/consumption` 原结果，不会重复扣积分。

### 后台（`/admin`）

- **独立管理员登录**：使用已授予 `admin` 角色的普通账号邮箱和密码登录；后台使用独立 Cookie 与会话，不影响前台用户登录，退出后台也不会退出商店账号。旧的全局管理员密码入口已移除。
- **商品管理**：上架 / 编辑 / 下架 / 删除商品。字段包含名称、副标题、详情、积分价、封面、所属分类、标签、库存（留空为不限）、排序、状态。
- **分类管理**：管理一级分类与二级子分类，支持排序、启用 / 隐藏；分类下有子分类或商品时禁止删除。
- **交付方式三选一**：
  - `文本`：兑换后直接显示文本内容，可复制（适合卡密、提取码、账号信息）。
  - `链接`：兑换后显示可点击链接（适合网盘分享链接、R2 公开域名）。
  - `文件`：后台上传文件到 R2（单文件 ≤ 50MB），用户点「下载文件」时由 Worker 校验登录态与订单归属后流式返回，链接不可被他人复用、不可枚举。
- **成交订单**：订单号、商品、用户邮箱、消耗积分、交付状态、时间。
- 站点名称 / 说明、一人付 `/capabilities` 与 `/product` 只读联调、平台购买与核销记录、Webhook 配置与签名轮换。
- **用户管理**：按邮箱搜索，查看身份、会话、订单数和店铺赠送积分；管理员可填写原因增加或扣减赠送积分并查看流水。支持设置角色、重置密码、停用/启用和删除账号；有待确认订单的账号不能删除，删除后保留积分流水供对账。
- **数据查看**：后台列表与卡片支持小屏幕；右上角「查看原数据」按需加载本地 Monaco（VS Code 同款编辑器），只读展示 JSON。
- **在线修改凭证**：一人付 API Key、Webhook 签名密钥均可在后台修改，存于 D1 `settings` 表并优先于 Worker Secret；接口只返回掩码，完整密钥不回传浏览器。所有敏感操作写入 `admin_audit`。

## 赠送积分与交付的关键约束

- **两本独立账**：支付宝积分由一人付管理；「店铺赠送积分」存于 D1 `bonus_wallets`，只在本店使用。后台调整的是店铺赠送积分，**不会增减支付宝余额**；余额页面分开显示两者。
- **优先赠送积分**：兑换在 D1 事务中预留库存及可用赠送积分，不足的部分才请求一人付核销。例如商品 10 分、赠送余额 3 分时，只向一人付核销 7 分。全部由赠送积分支付时，不需要一人付 API Key。
- **只在确认安全时交付或退还**：一人付成功须同时满足 `SUCCEEDED` 与 `confirmed=true`；提交前确认无法扣款或上游明确最终失败会原子返还赠送积分及库存。提交后超时、HTTP 错误、查询 404、`UNKNOWN` 或 `PROCESSING` 均保持待确认，**不交付、不猜测失败、不换业务编号重扣**。同一用户对同一商品已有待确认订单时不能创建新订单；用户可在「我的已购」同步原编号；若长期无法确认，需要管理员在一人付后台核对并联系平台，不能直接手工改库退款。
- 订单处理使用带租约的独占令牌；过期请求不能提交、返还或完成被新请求接管的订单。余额调整、库存与积分流水均使用 D1 原子事务和幂等操作编号。
- 涉及支付宝余额时，一人付收费方式必须是**积分 / 次数包（QUOTA）**；若是买断或时长包，只能使用足额赠送积分兑换。
- 订单保存商品交付内容**快照**。商品存在待确认或已完成订单时，「删除」改为下架；用户存在待确认订单时禁止删除。
- `user_id` 始终取自已认证的 D1 用户；管理员接口再次验证独立后台会话与角色。

### 升级已有数据库

**新代码依赖 `0006_bonus_points.sql`；上线前必须先迁移**，否则余额、用户列表及兑换接口会报错。旧订单的 `bonus_points_used` 默认为 0，不会把历史支付宝扣减当成赠送积分。正式升级应先备份 D1、暂停新兑换并确保旧 Worker 已停止处理订单，然后应用迁移、部署新版本再恢复流量。未确认的旧订单保留原业务编号查询，不要重建或手工退款。

```bash
# 仅在获得正式上线授权后操作远程数据库
npx wrangler d1 migrations apply onepay-shop --remote
# 本地开发使用 --local，而非 --remote
npx wrangler d1 migrations apply onepay-shop --local
```

## 先决条件

1. 在 [一人付控制台](https://ai6666.com/opcpay/console/) 创建项目，把收费方式配置为**积分 / 次数包**，申请项目 API Key。
2. 安装 Node.js 20.3+、npm 与 Wrangler CLI：

```bash
npm install
npx wrangler login
```

3. 建立 D1 并把 ID 写入 `wrangler.toml` 的 `database_id`：

```bash
npx wrangler d1 create onepay-shop
```

4. 应用全部数据库迁移（包含商品、订单、账号角色与赠送积分）：

```bash
npx wrangler d1 migrations apply onepay-shop --remote
```

5. 写入 Worker Secrets：

```bash
npx wrangler secret put YIRENFU_API_KEY
```

只有成功创建通知配置 / 轮换通知签名后，才需要：

```bash
npx wrangler secret put YIRENFU_WEBHOOK_SECRET
```

> 后台不再使用 `ADMIN_PASSWORD` 全局密码。管理员权限属于普通账号上的 `admin` 角色，登录方式见下文「创建管理员账号」。

> 密码哈希使用 PBKDF2-SHA256。Cloudflare Workers 的 WebCrypto 对 PBKDF2 迭代次数上限为 **100000**，超过会直接抛错；代码固定为 100000，不要自行调高。

6. （可选）绑定 R2 用于「文件」交付：

```bash
npx wrangler r2 bucket create onepay-shop-files
```

然后在 `wrangler.toml` 中取消这三行注释并重新部署：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "onepay-shop-files"
```

未绑定时后台「上传文件」会明确提示未配置，此时用「链接」方式交付网盘地址即可。

7. 部署 / 预览：

```bash
npm run dev
npm run deploy
```

## 创建管理员账号

后台账号就是普通账号，只是拥有 `admin` 角色：

1. 先在商店前台注册账号。
2. 在 D1 中把该账号设为管理员：

```bash
npx wrangler d1 execute onepay-shop --remote --command "UPDATE users SET role='admin' WHERE email='admin@example.com';"
```

3. 打开 `/admin`，用该账号的邮箱和密码登录。

之后可在后台「用户管理」直接设置或取消管理员角色，不需要再操作数据库。`0004` 迁移会把迁移前已存在的 `zj` 开头账号提升为管理员；此后新注册的账号不会仅凭邮箱前缀自动获得后台权限，避免公开注册导致提权。

## 上架第一件商品

1. 打开 `/admin`，使用管理员账号登录。
2. 进入「商品管理」→「+ 上架新商品」。
3. 填名称、积分价，选择交付方式：
   - 文本：把卡密 / 提取码 / 使用说明粘进「交付文本」。
   - 链接：粘贴网盘分享链接（如 `https://pan.baidu.com/s/...`）。
   - 文件：点「上传文件」传到 R2，再填下载显示名。
4. 库存留空表示不限；状态选「上架」后保存。
5. 回到前台 `/` 即可看到商品，登录用户用积分兑换。

## Cloudflare 配置说明

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `YIRENFU_API_KEY` | Worker Secret | 一人付 API 请求，只在服务端发出 |
| `YIRENFU_WEBHOOK_SECRET` | Worker Secret | 校验一人付通知签名 |
| `DB` | D1 绑定 | 账号、会话、商品、订单、核销与去重记录 |
| `BUCKET` | R2 绑定 | 商品文件存储 |
| `ASSETS` | 静态资源 | `public/` 下的前台与后台页面 |
| `COOKIE_NAME` | 环境变量 | 前台用户会话 Cookie |
| `ADMIN_COOKIE_NAME` | 环境变量 | 后台管理员独立会话 Cookie |

`wrangler.toml` 中的 `database_id` 必须替换为你的 D1 ID；仓库不包含任何生产凭证。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/products` | 已上架商品（不含交付内容）；支持 `q`、`category`、`tag` 筛选 |
| GET | `/api/categories` | 前台可见的一级分类与子分类，含商品数 |
| POST | `/api/products/:id/purchase` | 用积分兑换，body `{ idempotency_key }` |
| GET | `/api/orders` | 我的订单与已交付内容 |
| POST | `/api/orders/sync` | 同步待确认订单（查 `/consumption`） |
| GET | `/api/download/:orderKey` | 下载文件交付（需登录且为订单本人） |
| GET | `/api/product` | 一人付充值套餐（只读） |
| POST | `/api/purchase` | 创建积分充值购买入口 |
| GET | `/api/access` | 店铺赠送及支付宝积分分项；支付宝不可用时仍返回店铺余额 |
| POST | `/api/admin/login` | 管理员账号登录，body `{ email, password }` |
| GET | `/api/admin/me` | 当前独立后台会话 |
| POST | `/api/admin/logout` | 退出后台，不影响前台会话 |
| GET/POST/PUT/DELETE | `/api/admin/products[/:id]` | 商品管理（含分类与标签） |
| GET/POST/PUT/DELETE | `/api/admin/categories[/:id]` | 一级分类 / 二级子分类管理 |
| POST | `/api/admin/upload` | 上传交付文件到 R2（multipart） |
| GET | `/api/admin/orders` | 成交订单列表 |
| POST | `/api/admin/users/:id/role` | 设置管理员角色，body `{ role: "admin" \| "user" }` |
| GET | `/api/admin/users/:id/bonus` | 店铺赠送积分余额与最近流水 |
| POST | `/api/admin/users/:id/bonus` | 调整赠送积分，body `{ delta, reason, idempotency_key }`；操作编号可安全重试 |

## 缓存策略

公共数据由 Cloudflare Cache API 在边缘数据中心缓存，并允许浏览器短时间复用：

| 公开 GET 接口 | 边缘缓存 | 浏览器缓存 |
| --- | --- | --- |
| `/api/products`（含 `q`、`category`、`tag` 筛选） | 30 秒 | 5 秒 |
| `/api/categories` | 60 秒 | 10 秒 |
| `/api/config` | 300 秒 | 30 秒 |
| `/api/product`（充值套餐） | 60 秒 | 10 秒 |

仅成功的公开 JSON 响应进入共享缓存；包含 `Set-Cookie` 或 `Vary` 的公开 JSON 响应及错误响应不共享。登录态、余额、订单、交付、充值及后台接口保持 `private, no-store`。缓存异常时自动回源，不影响已经完成的业务写入。

- 后台修改商品、分类，或兑换过程中预留、回滚、同步释放库存，会使**处理该写入请求的同一域名、同一数据中心**内的商品和分类缓存失效，包括不同筛选条件；站点配置及套餐缓存分别独立失效。浏览器已有的短缓存不会被主动清除，兑换完成或失败后商店会强制刷新库存。若缓存失效操作失败，旧数据仍会随 TTL 过期。
- Cloudflare Cache API 的缓存按数据中心隔离，不是全球同步失效：其他域名或数据中心的旧数据要等对应的边缘 TTL 到期；浏览器若刚取到旧数据，还可能多保留其浏览器 TTL。可用请求头 `Cache-Control: no-cache` 强制回源并刷新当前数据中心的缓存。实际库存和积分仍由服务端在兑换时校验。
- 前台 HTML 外壳浏览器缓存 30 秒、共享缓存最多 60 秒，后台 HTML `private, no-store`。带 `?v=` 版本号的 CSS/JS 缓存 24 小时并标记 `immutable`，其他公开静态资源缓存 1 小时。**修改 CSS/JS 时应同步更新引用它的 HTML 中的版本号**，避免浏览器继续使用旧资源；HTML 更新可能受共享及浏览器缓存时间影响。
- 可缓存的公开 JSON 响应的 `x-cache` 标记为 `HIT`、`MISS`、`REFRESH` 或 `BYPASS`；静态资源标记为 `ASSET`。缓存写入异步完成，刚刚首次请求之后的并发请求也可能暂时显示 `MISS`。

## 安全行为

- 前台用户与后台管理员使用不同 Cookie；后台每次请求都会重新校验账号角色与停用状态，降权、停用后旧后台会话立即失效。
- 管理员角色只能由现有管理员在后台授予；新注册账号固定为普通用户，不按邮箱前缀自动提权。
- 前端价格仅用于展示；购买积分只传有效 `sku_id`，不传价格或 plan ID。
- 兑换商品时扣减数量由服务端按商品当前积分价决定，前端传价格无效。
- 文件下载走 `/api/download/:orderKey`，校验会话 + 订单归属，R2 桶无需公开。
- 通知只表示权益 / 核销变化，不作为付款成功信号；事件按 ID 去重。
- 不在日志输出请求凭证、Webhook secret、密码或完整用户请求内容。

## 开发与测试

- `npm run dev` / `npm run deploy` 会先运行 `npm run build:editor`，使用 `scripts/admin-editor.js` 与 esbuild 构建本地 Monaco 只读编辑器至 `public/vendor/monaco/`；静态文件随应用发布，不依赖第三方 CDN。编辑器文件及字体、工作线程发生变化时应更新引用版本号。Monaco 遵循其目录下的 MIT 许可证。
- `npm test` 运行回归测试；涉及真实 SQLite 事务、并发和恢复的积分测试需要 Node.js 22+ 内置 `node:sqlite`（Node 20 下这部分会跳过）。`npm run check` 检查脚本语法。
