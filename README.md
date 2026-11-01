# OnePay Shop · Cloudflare Worker

一个基于 Cloudflare Workers + D1 的**积分制数字商品商店**与管理后台。

模型很直接：用户先用支付宝**充值积分**（收费方式走一人付的 QUOTA / 积分包），再用积分在货架上**兑换商品**；商品交付内容由管理员在后台配置，支持**文本**（卡密、提取码）、**链接**（网盘分享地址、R2 公开域名）和**文件**（上传到 Cloudflare R2，凭订单下载）。

项目复用一人付现有收费方式与服务端权益判断，不在商户站点自行定价或把「打开支付宝」误当成支付成功。

## 交付能力

### 前台

- **首页（`/`）**：品牌入口与分类导航，不再直接堆叠商品货架。
- **商品页（`/shop`）**：独立商品目录，支持按一级分类、二级子分类、多选标签、关键词筛选与积分排序；多个标签需同时满足；父分类自动包含其子分类商品；排序与筛选会写进 URL，可直接分享。
- **商品详情（`/product?id=<商品编号>`）**：完整商品介绍、标签、库存、交付说明、资源目录快照、相关推荐与同款兑换流程；卡片封面与标题可直接进入，可单独分享给他人。已下架商品的详情接口返回 404。
- **个人中心（`/account`）**：注册 / 登录、积分余额与累计消费、充值套餐、我的已购（含待确认角标）、我的订阅与账户信息；面板按需加载，已登录用户可自助修改密码。充值入口只放在个人中心。
- **积分充值**：只读加载一人付当前 `/product` 可售积分套餐，点击后拿 `purchase_url` 跳转支付宝；入口状态不等于支付成功。
- **积分兑换**：先使用店铺赠送积分；不足部分再用 `/consume` 幂等核销支付宝积分。涉及一人付时，**只有 `status=SUCCEEDED && confirmed=true` 才交付内容**；纯赠送积分订单无需请求一人付。
- **我的已购**：普通商品交付快照保存在订单中；文本可复制、链接可打开、文件走订单专属下载地址。系列内容在「我的订阅」中按有效期访问。
- **订阅系列**：管理员选择永久或 1–3650 天；限时订阅到期停止站内访问，用户手动续费，不会自动扣费。有效期内可查看历史和新增的系列更新。
- 待确认订单可点「同步待确认订单」查询一人付 `/consumption` 原结果，不会重复扣积分。

### 后台（`/admin`）

- **独立管理员登录**：使用已授予 `admin` 角色的普通账号邮箱和密码登录；后台使用独立 Cookie 与会话，不影响前台用户登录，退出后台也不会退出商店账号。旧的全局管理员密码入口已移除。
- **商品管理**：上架 / 编辑 / 下架 / 删除商品。字段包含名称、副标题、详情、积分价、封面、所属分类、标签、库存（留空为不限）、排序、状态、是否允许重复购买及订阅规则。识别夸克 / 百度分享后自动加入平台标签，可尝试读取公开目录或手工填写；目录需要管理员检查并保存后才会公开。
- **系列更新**：为同一订阅商品追加文字、链接或 R2 文件，支持草稿、发布、修改和删除；仅有效订阅者读取已发布内容。
- **Agent 接入**：后台生成 5 分钟有效的一次性配对码，Agent 换取 30 天令牌；可查看、撤销已配对的 Agent，并复制 `agent.md` 提示词。
- **分类管理**：管理一级分类与二级子分类，支持排序、启用 / 隐藏；分类下有子分类或商品时禁止删除。
- **交付方式三选一**：
  - `文本`：兑换后直接显示文本内容，可复制（适合卡密、提取码、账号信息）。
  - `链接`：兑换后显示可点击链接（适合网盘分享链接、R2 公开域名）。
  - `文件`：后台上传文件到 R2（单文件 ≤ 50MB），用户点「下载文件」时由 Worker 校验登录态与订单归属后流式返回，链接不可被他人复用、不可枚举。
- **成交订单**：按状态筛选、按订单号 / 邮箱 / 商品名搜索，分页显示并给出总数与待确认数量；列表包含订单号、商品、用户邮箱、消耗积分、交付状态、时间。
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
- **禁止重复购买**：所有新商品和迁移前商品默认不允许同一用户重复购买普通商品；后台可逐个开启。同一用户、同一商品仍只允许一笔待确认订单。永久订阅不得再次扣费；限时订阅可手动续订。
- **订阅开通和续期**：订单成功交付与权益写入在同一个 D1 batch 中完成；有效期内续订从原到期日顺延，过期后从重新开通时计算。同一个订单编号的重试不会重复延长。前台确认会提交商品价格、类型、期限和订阅状态版本，服务端在预留时原子校验；新订阅订单必须提供这些确认字段。普通商品可兼容不传确认字段的旧客户端，仍按服务端现价处理；原订单编号重试无需重复提交条款。
- **范围与回收**：每日 / 每周只是内容更新频率，不是自动扣费周期。到期后 API 拒绝站内读取和下载，但已下载的文件或已复制的外部链接无法被本站回收。商品下架不取消现有有效订阅，只停止新购买 / 续费；已发布的更新仍可访问。
- **类型锁定**：有待确认 / 已交付订单或系列更新时不能在普通商品和订阅系列间切换类型；更改时长仅影响之后新订单，不回溯修改已取得的权益。
- 订单保存商品交付内容**快照**。商品存在待确认或已完成订单时，「删除」改为下架；用户存在待确认订单时禁止删除。
- `user_id` 始终取自已认证的 D1 用户；管理员接口再次验证独立后台会话与角色。

### 升级已有数据库

**新代码依赖 `0006_bonus_points.sql`、`0007_catalog_agent.sql`、`0008_subscriptions_and_repeat.sql`、`0009_agent_pairing.sql` 和 `0010_auth_throttle.sql`；上线前必须先迁移**，否则商品、兑换、订阅、用户管理或 Agent 接口可能报错。`0008` 将旧商品设为不允许重复购买，历史订单视为普通商品订单，不会自动变为订阅；`0009` 新增 Agent 配对、凭据和限流表；`0010` 新增登录失败计数表与充值入口查询索引（缺失时接口会 fail-open，不会锁死登录，但限流与索引不会生效）。`0009` 存在两个同名编号的迁移文件（`0009_agent_pairing.sql`、`0009_netdisk_scans.sql`），按文件名字典序执行，**不要改名已部署的迁移文件**，新增迁移从 `0010` 起顺延。旧订单的 `bonus_points_used` 默认为 0，不会把历史支付宝扣减当成赠送积分。正式升级应先备份 D1、暂停新兑换及后台账号管理，确保**所有旧 Worker 版本停止处理兑换和管理请求**，再应用迁移、部署新版本、验证后恢复流量。旧版管理接口不会撤销新配对的 Agent 凭据，升级期间也不要让旧版处理 Agent / 管理请求。旧代码不能保证新的重复购买和订阅规则，迁移后不可让新旧版本同时处理兑换。未确认的旧订单保留原业务编号查询，不要重建或手工退款；回滚前应暂停兑换并核对新订单及权益，不能直接用旧版代码继续处理订阅。

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

4. 应用全部数据库迁移（包含商品、订单、账号角色、赠送积分、目录快照、Agent 幂等记录、订阅权益、目录扫描进度与 Agent 配对）：

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

确认 `wrangler.toml` 中的 R2 桶名称与实际桶一致（示例如下）：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "onepay-shop-files"
```

未绑定时后台「上传文件」会明确提示未配置，此时用「链接」方式交付网盘地址即可。

7. 部署 / 预览：

本地默认使用 `wrangler.dev.toml`（本地 D1 / R2，不绑定远程 AI），无需 Cloudflare 登录即可预览；封面生成会提示未配置。需要真实测试 AI 时，使用正式配置启动 `npx wrangler dev --config wrangler.toml --ip 0.0.0.0`，需先登录 Cloudflare，调用真实远程 Workers AI 并可能产生费用。两份配置中的 D1 ID / 桶名若更改，请保持同步。

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

### 恢复误停用的管理员

如果没有其他管理员可以在后台启用该账号，请先备份 D1，并确认 Wrangler 当前登录的 Cloudflare 账号和仓库 `wrangler.toml` 中的数据库均正确。以下 `--remote` 命令直接操作远程数据库，不会部署 Worker。先查看管理员账号并记下需恢复的完整 ID：

```bash
npx wrangler d1 execute onepay-shop --remote --config wrangler.toml --command "SELECT id,email,role,disabled FROM users WHERE role='admin';"
```

将下面的 `替换为完整管理员ID` 换成刚刚确认的 ID 后执行。命令只启用仍具有 `admin` 角色且已停用的指定账号，不修改密码或授予权限：

```bash
npx wrangler d1 execute onepay-shop --remote --config wrangler.toml --command "UPDATE users SET disabled=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='替换为完整管理员ID' AND role='admin' AND disabled=1;"
```

再次执行查询，确认该账号的 `disabled` 为 `0`。停用时原会话已被撤销，恢复后请用原邮箱和密码重新登录 `/admin`。若找不到账号或角色不是 `admin`，不要盲目执行提权，应先确认账号和数据库。

## 上架第一件商品

1. 打开 `/admin`，使用管理员账号登录。
2. 进入「商品管理」→「+ 上架新商品」。
3. 填名称、积分价，选择交付方式：
   - 文本：把卡密 / 提取码 / 使用说明粘进「交付文本」。
   - 链接：粘贴网盘分享链接（如 `https://pan.baidu.com/s/1…`）；夸克 / 百度会自动识别并尝试读取。大目录会分成多批读取并显示进度条，每一批只消耗少量上游请求，避免单次请求中途失败；可用提取码读取，失败可手工填写目录，检查无私密信息后保存。提取码输入框只用于读取；买家需要时，可在私密交付链接中附带 `?pwd=提取码`。
   - 文件：点「上传文件」传到 R2，再填下载显示名。
4. 普通商品默认不允许重复兑换，可在「重复购买」中单独开启；库存留空表示不限，状态选「上架」后保存。
5. 回到前台 `/` 即可看到商品，登录用户用积分兑换。

订阅 API 新建订单时需从公开商品获取 `price_points`、`product_kind`、`subscription_days`，从私有 `/api/library` 获取本人该商品的 `revision`（无订阅则为 `none`），分别提交为 `expected_price`、`expected_kind`、`expected_days`、`subscription_revision`。确认期间条款或权益变化时服务端拒绝扣费，需刷新后重新确认；原幂等编号的重试仍查询原订单。

## 上架持续更新系列

1. 在「商品管理」新建商品，类型选「订阅系列」，填写积分价、永久 / 限时天数及更新频率。每日 / 每周是更新说明，不会触发自动扣费。
2. 如需购买前展示目录，可手动填写公开名称；不要填写私密 URL、提取码或文件内容。保存商品。
3. 在商品列表点「系列更新」，追加文字、链接或上传不超过 50 MB 的 R2 文件。可保存草稿，只有发布后的更新对有效订阅者可见。可修改或删除更新。
4. 用户在个人中心「我的订阅」查看历史和新增内容；限时订阅到期后可到商店手动续订。续订前仔细确认价格与时长。订阅更新接口及文件下载均每次检查用户身份与有效期，不使用公共缓存。

订阅不保证定时自动发布，由管理员自行更新；已下载文件与已复制的外部链接无法撤回。订阅商品存在待确认 / 已交付订单时删除会改为下架，现有有效订阅仍能访问更新。

## Cloudflare 配置说明

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `YIRENFU_API_KEY` | Worker Secret | 一人付 API 请求，只在服务端发出 |
| `YIRENFU_WEBHOOK_SECRET` | Worker Secret | 校验一人付通知签名 |
| `DB` | D1 绑定 | 账号、会话、商品、订单、核销与去重记录 |
| `BUCKET` | R2 绑定 | 私有商品文件及公开封面存储 |
| `AI` | Workers AI 绑定 | 管理员手动生成封面；已在 Wrangler 配置 |
| `AGENT_API_TOKEN` | 可选 Worker Secret | 兼容旧版固定 Agent 令牌；配对模式不需要配置。旧固定令牌不会自动过期 |
| `ASSETS` | 静态资源 | `public/` 下的前台与后台页面 |
| `COOKIE_NAME` | 环境变量 | 前台用户会话 Cookie |
| `ADMIN_COOKIE_NAME` | 环境变量 | 后台管理员独立会话 Cookie |

`wrangler.toml` 中的 `database_id` 必须替换为你的 D1 ID；仓库不包含任何生产凭证。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/products` | 已上架商品（不含交付内容）；支持 `q`、`category`、重复 `tag` 参数筛选（最多 8 个，AND 关系） |
| GET | `/api/categories` | 前台可见的一级分类与子分类，含商品数 |
| POST | `/api/products/:id/purchase` | 用积分兑换，body `{ idempotency_key, expected_price?, expected_kind?, expected_days?, subscription_revision? }`；订阅新订单必须带确认字段，普通商品可选；这些字段用于防止按旧条件扣费，不能指定实际扣费金额 |
| GET | `/api/orders?offset=0` | 本人的订单与已交付内容，每页 50 项 |
| GET | `/api/library` | 本人的普通商品 ID 和订阅状态（私有，不缓存） |
| GET | `/api/subscriptions` | 本人的订阅及有效期（私有，不缓存） |
| GET | `/api/subscriptions/:product/updates?offset=0` | 有效订阅者读取已发布更新，每页 30 项 |
| GET | `/api/subscriptions/:product/updates/:update/file` | 校验本人订阅及发布状态后下载系列文件 |
| POST | `/api/orders/sync` | 同步待确认订单（查 `/consumption`） |
| GET | `/api/products/:id` | 单个已上架商品详情（不含交付内容），随商品缓存一起失效；下架或不存在返回 404 |
| GET | `/api/download/:orderKey` | 下载文件交付（需登录且为订单本人） |
| GET | `/api/product` | 一人付充值套餐（只读） |
| POST | `/api/purchase` | 创建积分充值购买入口 |
| GET | `/api/access` | 店铺赠送及支付宝积分分项、`spent_points`（累计消费）、`order_count`（已交付订单）、`pending_orders`（待确认订单）；支付宝不可用时仍返回店铺余额与上述统计 |
| POST | `/api/auth/register` | 注册普通账号，body `{ email, password }`（密码 10–128 位） |
| POST | `/api/auth/login` | 账号登录；连续失败会限流 |
| POST | `/api/auth/password` | 已登录用户修改密码，body `{ current_password, new_password }`；成功后其他设备的会话失效 |
| POST | `/api/admin/login` | 管理员账号登录，body `{ email, password }`；与前台登录分别限流 |
| GET | `/api/admin/me` | 当前独立后台会话 |
| POST | `/api/admin/logout` | 退出后台，不影响前台会话 |
| GET/POST/PUT/DELETE | `/api/admin/products[/:id]` | 商品管理（含重复购买与订阅规则） |
| GET/POST/PUT/DELETE | `/api/admin/products/:id/updates[/:update]` | 管理系列更新，列表每页 50 项 |
| GET | `/api/admin/status` | 管理员读取服务、R2、Agent 配对数据库及旧版固定令牌配置状态；不返回凭据 |
| POST/DELETE | `/api/admin/agent/pairing` | 生成或作废本管理员的一次性配对码 |
| GET | `/api/admin/agent/pairing/:id` | 查询本管理员的配对码状态，不返回码 |
| GET/DELETE | `/api/admin/agent/tokens[/:id]` | 列出、撤销已配对 Agent 的令牌，不返回明文 |
| GET/POST/PUT/DELETE | `/api/admin/categories[/:id]` | 一级分类 / 二级子分类管理 |
| POST | `/api/admin/upload` | 上传交付文件到 R2（multipart） |
| POST | `/api/admin/netdisk/preview` | 管理员分批读取公开分享目录，body `{ url, passcode?, scan_id? }`；返回文件名快照、`done`、`progress` 与续读用 `scan_id`；大目录由前端循环调用直到完成 |
| POST | `/api/admin/covers/generate` | 管理员手动生成封面，body `{ prompt }` |
| GET | `/api/covers/:id` | 公开查看生成的封面，不提供商品文件访问 |
| POST | `/api/agent/pair` | 用 10 位配对码换取 30 天 Agent Bearer 令牌（匿名、一次性、限流） |
| POST | `/api/agent/uploads` | Bearer 令牌上传 Agent 文件（multipart） |
| POST | `/api/agent/drafts` | Bearer 令牌关联已上传文件并创建隐藏草稿（幂等） |
| GET | `/api/admin/orders` | 成交订单列表，支持 `status`（PENDING / DELIVERED / FAILED）、`q`（订单号 / 邮箱 / 商品名 / 业务编号）、`limit`、`offset`，返回 `total`、`pending_total`、`has_more` |
| POST | `/api/admin/users/:id/role` | 设置管理员角色，body `{ role: "admin" \| "user" }` |
| GET | `/api/admin/users/:id/bonus` | 店铺赠送积分余额与最近流水 |
| POST | `/api/admin/users/:id/bonus` | 调整赠送积分，body `{ delta, reason, idempotency_key }`；操作编号可安全重试 |

## 目录快照、图标与 AI 封面

- 后台粘贴 `https://pan.quark.cn/s/...`（或 `https://drive.quark.cn/s/...`）或 `https://pan.baidu.com/s/1...` 后自动识别并尝试读取（离开输入框后触发），可输入提取码再点「读取网盘目录」。其他链接和读取失败时可以手动填写。夸克先尝试按 Skill 1.0.20 调查所得的客态首页和翻页路径，失败时兼容原来的游客接口；不使用网盘账号 Cookie。百度提取码验证得到的分享 Cookie 仅在该次请求内使用。此适配**尚未完成真实夸克联调**，平台可能因变更、登录、风控或权限要求而拒绝访问，不能保证每个分享都可读。接口与验证边界见 [夸克分享目录调查](docs/quark-share-protocol.md)。
- 读取根目录和最多三层子目录；夸克若以单个文件夹包装分享，会额外展开这层包装。最多 150 项、每项路径 320 字、12 次列表请求（包括夸克首页和备用主机重试）；超出、无法继续读取或存在更深文件夹会标记为「部分目录」。夸克目录使用 50 项分页并尽可能读取对应目录总数。失败时后台会显示步骤、HTTP 状态和数字平台码等诊断信息，不显示上游消息或凭据；排查时不要分享链接、提取码、Cookie 或 token。
- 这不是实时列表。管理员检查并保存后，消费者可在商品卡片点「查看资源目录」，展开文件夹并查看文件名；其名称及更新时间会公开。**不要把链接、提取码、个人资料或其他敏感信息写进目录名称**；管理员有责任审核内容。交付 URL、读取用提取码、平台 token 和文件 ID 不会放在公共商品 API 中。
- 分享提取码输入框仅用于本次读取，不会保存或单独随订单交付。如买家需要提取码，可以在私密交付链接中附带 `?pwd=提取码`；兑换成功后该完整 URL 会显示给买家。链接变化后旧目录会清空，需要重新读取或填写。平台标签占 8 个标签中的一个位置。
- 商店 Logo 位于 `public/assets/brand-logo.svg`。网盘来源标识仅用于识别平台：夸克标识来自 [应用宝的夸克网盘页面](https://sj.qq.com/appdetail/com.tencent.pcgame.quakuakewangpanpdfbeifenbofangqi)，百度标识来自 [应用宝的百度网盘页面](https://sj.qq.com/appdetail/com.baidu.netdisk)；商标权利归各自权利人所有。
- 后台商品表单展开「AI 生成商品封面」，填写描述、确认费用提示后才会调用 `@cf/black-forest-labs/flux-1-schnell`，预览满意后点击「使用这张封面」并保存商品。需要 `AI` 与 `BUCKET` 绑定。生成的封面以不可预测的 URL 公开读取，**不要输入敏感信息**；未选用的封面也保留在 R2，需自行清理。
- [Workers AI 价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)：截至 2026-10，账户每天有 10,000 **Neurons** 共享免费额度（不是 10,000 张图片，UTC 零点重置）；Free 计划超额请求失败，付费计划超额可能收费。额度会与账户其他 AI 应用共享，手动确认不保证零费用，请自行监控与设置账户限额。

## 外部 Agent 文件接口

Agent 只允许上传文件（单个不超过 50 MB）并创建**下架草稿**；它不能登录后台、发布商品、修改订单或读取用户资料。管理员仍需检查内容、价格、版权与分类，再手动上架。上传文件存入 R2 私有 `agent/` 前缀，下载仍需本人有效订单。

### 推荐：一次性配对

1. 先绑定 R2、应用全部 D1 迁移（包括 `0009_agent_pairing.sql`）并部署新版；这需要正式上线授权。配对方式不需要配置 `AGENT_API_TOKEN` Worker Secret。
2. 登录后台的「Agent 接入」，可填写便于识别的备注（不要填密钥），点「生成 10 位配对码」。同一管理员生成新码会作废其旧的未使用码。
3. 将配对码或「复制配对指令」交给**受信任的** Agent。配对指令含该一次性码，不应公开、写入仓库或放进 URL；纯 `agent.md` 提示词只含占位符。
4. Agent 在 **5 分钟**内用 HTTPS POST `/api/agent/pair`，JSON 请求体为 `{"code":"<10位数字字符串>"}`（保留前导零）。成功响应仅显示一次 `access_token`、`credential_id`、`expires_at` 和 `expires_in`。Agent 应将令牌放进受限本地凭据存储或环境变量，不要回显到聊天、日志或仓库。
5. 令牌有效期为 **30 天**、不会自动续期。过期或撤销后需重新配对；如配对响应丢失，旧码无法重用，应重新生成，并在后台检查和撤销不再使用的凭据。
6. 后台「已配对的 Agent」可按备注查看状态和撤销。撤销阻止后续请求，已在处理中的请求可能完成。签发管理员被停用、降权或重置密码时，其配对码和令牌也会失效。

配对码使用加盐 PBKDF2 哈希，Bearer 令牌使用 SHA-256 哈希；数据库不存储二者明文。匿名配对接口对每个客户端每 5 分钟最多 5 次，并设有每 5 分钟最多 100 次的全局上限；失败尝试也计数。达到限制返回 429 和 `Retry-After`。这些计数存储在 D1，客户端地址只保存哈希、不存明文；过期计数在后续配对请求时清理。这不能替代 Cloudflare WAF / 边缘限流以防止 D1 被流量耗尽。非同源浏览器请求会被拒绝，外部 Agent 应以服务端工具发起无 Origin 的 HTTPS 请求。

### 旧版固定令牌（可选）

如已设置 `AGENT_API_TOKEN` Worker Secret，旧 Agent 可继续使用它，但**该固定令牌不会自动过期，也不受后台配对令牌撤销操作影响**。如需只使用 30 天配对令牌，应在获得上线授权后单独移除旧 Secret；泄露时应立即轮换或移除。首次配置旧模式可使用高随机度 32–512 个非空白字符，不要复用其他凭据。

```bash
# 仅在获得线上配置授权后执行；在交互提示中输入随机值，不要写入仓库或聊天
npx wrangler secret put AGENT_API_TOKEN
```

### 上传和创建草稿

无论使用配对令牌或旧版令牌，之后 Agent 通过 HTTPS 使用 `Authorization: Bearer …` 请求，以下命令假定令牌已安全放入当前进程的 `AGENT_API_TOKEN` 环境变量（不要放在 URL 中）：

```bash
# 第一步：上传已由外部 Agent 生成的文件；响应含 key、name、size
curl --fail-with-body https://YOUR_SHOP_DOMAIN/api/agent/uploads \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -F 'file=@./generated.zip'

# 第二步：用上一步的 key 创建草稿，idempotency_key 应由 Agent 唯一生成并在重试时复用
curl --fail-with-body https://YOUR_SHOP_DOMAIN/api/agent/drafts \
  -H "Authorization: Bearer $AGENT_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"idempotency_key":"agent-job-unique-001","title":"生成的资料包","price_points":20,"file_key":"上传响应中的key","file_name":"generated.zip","tags":["资料"]}'
```

相同编号和内容重试返回原草稿；同一编号用于不同内容返回 409；草稿删除后原编号不能重新创建。Agent 即使提交 `status: ACTIVE` 也只会得到隐藏草稿。上传请求本身不去重，失败重试可能留下未关联文件，应定期清理 R2 中无引用的 `agent/` 对象。配对令牌泄露时在后台立即撤销；旧版固定令牌需单独轮换或移除。上传与草稿接口尚无内置全局限流，建议额外配置 Cloudflare WAF / API 速率限制。

## 缓存策略

公共数据由 Cloudflare Cache API 在边缘数据中心缓存，并允许浏览器短时间复用：

| 公开 GET 接口 | 边缘缓存 | 浏览器缓存 |
| --- | --- | --- |
| `/api/products`（含 `q`、`category`、`tag` 筛选）与 `/api/products/:id` | 30 秒 | 5 秒 |
| `/api/categories` | 60 秒 | 10 秒 |
| `/api/config` | 300 秒 | 30 秒 |
| `/api/product`（充值套餐） | 60 秒 | 10 秒 |

仅成功的公开 JSON 响应进入共享缓存；包含 `Set-Cookie` 或 `Vary` 的公开 JSON 响应及错误响应不共享。登录态、余额、订单、订阅状态和更新、交付、充值及后台接口保持 `private, no-store`。缓存异常时自动回源，不影响已经完成的业务写入。

- 后台修改商品、分类，或兑换过程中预留、回滚、同步释放库存，会使**处理该写入请求的同一域名、同一数据中心**内的商品和分类缓存失效，包括不同筛选条件；站点配置及套餐缓存分别独立失效。浏览器已有的短缓存不会被主动清除，兑换完成或失败后商店会强制刷新库存。若缓存失效操作失败，旧数据仍会随 TTL 过期。
- Cloudflare Cache API 的缓存按数据中心隔离，不是全球同步失效：其他域名或数据中心的旧数据要等对应的边缘 TTL 到期；浏览器若刚取到旧数据，还可能多保留其浏览器 TTL。可用请求头 `Cache-Control: no-cache` 强制回源并刷新当前数据中心的缓存。实际库存和积分仍由服务端在兑换时校验。
- 前台 HTML 外壳浏览器缓存 30 秒、共享缓存最多 60 秒，后台 HTML `private, no-store`。带 `?v=` 版本号的 CSS/JS 缓存 24 小时并标记 `immutable`，其他公开静态资源缓存 1 小时。**修改 CSS/JS 时应同步更新引用它的 HTML 中的版本号**，避免浏览器继续使用旧资源；HTML 更新可能受共享及浏览器缓存时间影响。
- 可缓存的公开 JSON 响应的 `x-cache` 标记为 `HIT`、`MISS`、`REFRESH` 或 `BYPASS`；静态资源标记为 `ASSET`。缓存写入异步完成，刚刚首次请求之后的并发请求也可能暂时显示 `MISS`。

## 安全行为

- 前台用户与后台管理员使用不同 Cookie；后台每次请求都会重新校验账号角色与停用状态，降权、停用后旧后台会话立即失效。管理员不能停用当前登录的账号，但仍可停用或启用其他账号。
- 管理员角色只能由现有管理员在后台授予；新注册账号固定为普通用户，不按邮箱前缀自动提权。
- 登录、注册、修改密码按「IP + 账号」统计失败次数：15 分钟内超过 8 次返回 429 与 `retry-after`；成功登录清零。计数表缺失时限流自动放行，保证不会被一次迁移遗漏锁在门外。
- 用户修改密码必须提供当前密码；成功后保留当前设备会话，其他设备会话全部失效。管理员仍可在后台重置任意账号密码并吊销其 Agent 凭据。
- 前端价格仅用于展示；购买积分只传有效 `sku_id`，不传价格或 plan ID。
- 兑换商品时扣减数量由服务端按商品当前积分价决定；前端可传预期价格、类型、期限和订阅状态版本作为一致性校验，但不能指定扣费金额。
- 普通文件下载走 `/api/download/:orderKey`，校验会话 + 订单归属；系列文件下载还需有效订阅及已发布状态。R2 桶无需公开。
- 通知只表示权益 / 核销变化，不作为付款成功信号；事件按 ID 去重。
- 不在日志输出请求凭证、Webhook secret、密码或完整用户请求内容。

## 开发与测试

- `npm run dev` / `npm run deploy` 会先运行 `npm run build:editor`，使用 `scripts/admin-editor.js` 与 esbuild 构建本地 Monaco 只读编辑器至 `public/vendor/monaco/`；静态文件随应用发布，不依赖第三方 CDN。编辑器文件及字体、工作线程发生变化时应更新引用版本号。Monaco 遵循其目录下的 MIT 许可证。
- `npm test` 运行回归测试；涉及真实 SQLite 事务、并发和恢复的积分测试需要 Node.js 22+ 内置 `node:sqlite`（Node 20 下这部分会跳过）。`npm run check` 检查脚本语法。
