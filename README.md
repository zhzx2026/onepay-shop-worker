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
- **积分兑换**：兑换时先校验余额，再用 `/consume` 幂等扣减积分，**只有 `status=SUCCEEDED && confirmed=true` 才交付内容**。
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
- **用户管理**：按邮箱搜索，查看身份、注册时间、最近登录、活跃会话、充值单数、已购数；支持设为管理员 / 取消管理员、重置密码、停用/启用、删除账号（同时清理其订单与核销记录）。
- **在线修改凭证**：一人付 API Key、Webhook 签名密钥均可在后台修改，存于 D1 `settings` 表并优先于 Worker Secret；接口只返回掩码，完整密钥不回传浏览器。所有敏感操作写入 `admin_audit`。

## 积分与交付的关键约束

- 兑换流程为「**先占库存 → 再扣积分 → 确认后交付**」：
  - 积分不足 → 返回 `402 POINTS_INSUFFICIENT`，库存立即释放，不会扣分。
  - 一人付返回 `UNKNOWN` / `PROCESSING` → 订单保持 `PENDING`，**不交付**，稍后同步；同一 `idempotency_key` 不会重复扣减。
  - 明确失败（4xx）→ 释放库存、订单标记 `FAILED`。
- 一人付收费方式必须是**积分 / 次数包（QUOTA）**。若仍是买断或时长包，兑换接口返回 `409 BILLING_MODE_NOT_QUOTA` 并提示去控制台切换。
- 订单保存商品交付内容**快照**：之后修改或下架商品，不影响已购用户已获得的内容。
- 已有成交记录的商品执行「删除」时只做下架，避免用户已购内容失效。
- `user_id` 永远取自 Worker 已认证的 D1 用户，不接受前端指定。

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

4. 应用数据库迁移（包含商品、订单、分类标签与账号角色）：

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
| GET | `/api/access` | 积分余额 |
| POST | `/api/admin/login` | 管理员账号登录，body `{ email, password }` |
| GET | `/api/admin/me` | 当前独立后台会话 |
| POST | `/api/admin/logout` | 退出后台，不影响前台会话 |
| GET/POST/PUT/DELETE | `/api/admin/products[/:id]` | 商品管理（含分类与标签） |
| GET/POST/PUT/DELETE | `/api/admin/categories[/:id]` | 一级分类 / 二级子分类管理 |
| POST | `/api/admin/upload` | 上传交付文件到 R2（multipart） |
| GET | `/api/admin/orders` | 成交订单列表 |
| POST | `/api/admin/users/:id/role` | 设置管理员角色，body `{ role: "admin" \| "user" }` |

## 缓存策略

- 静态页面与 `/storefront.css`、`/storefront.js`：`s-maxage=300`，浏览器端 HTML 不缓存、静态资源缓存 60 秒。
- 公共数据接口使用 Cloudflare Cache API：
  - `/api/products`：30 秒边缘缓存
  - `/api/categories`：60 秒边缘缓存
  - `/api/config`：300 秒边缘缓存
  - `/api/product`：60 秒边缘缓存
- 后台修改站点配置、商品或分类后会立即清除当前域名的 `/api/products`、`/api/categories`、`/api/config` 缓存；商品兑换成功后也会清除商品缓存。
- 登录态、后台接口、订单、下载和充值接口始终 `private, no-store`，不会进入公共缓存。
- 前台 `storefront.js` 的 API 请求使用 `cache: no-store`，避免浏览器把公共数据缓存数小时；边缘缓存仍然生效。
- 缓存响应带 `x-cache: HIT | MISS`，静态资源带 `x-cache: ASSET`，便于排查。

## 安全行为

- 前台用户与后台管理员使用不同 Cookie；后台每次请求都会重新校验账号角色与停用状态，降权、停用后旧后台会话立即失效。
- 管理员角色只能由现有管理员在后台授予；新注册账号固定为普通用户，不按邮箱前缀自动提权。
- 前端价格仅用于展示；购买积分只传有效 `sku_id`，不传价格或 plan ID。
- 兑换商品时扣减数量由服务端按商品当前积分价决定，前端传价格无效。
- 文件下载走 `/api/download/:orderKey`，校验会话 + 订单归属，R2 桶无需公开。
- 通知只表示权益 / 核销变化，不作为付款成功信号；事件按 ID 去重。
- 不在日志输出请求凭证、Webhook secret、密码或完整用户请求内容。
