# 夸克分享目录接口调查（1.0.20）

> 状态：**接口结构已通过静态分析和隔离模拟确认，尚未与真实夸克服务或真实账号联调**。下面的网盘服地址不是面向公众承诺稳定的 API，字段、访问条件和风控规则可能随时变化。

## 依据与边界

- [夸克官方 1.0.20 的分享命令文档](https://github.com/quark-clouddrive/quarkclouddrive_offical/blob/509e3ada82c1ac4a251e13bac8ca9b858d125cfb/skills/quarkclouddrive/references/file-share.md)称 `share-detail` 支持翻页、子目录及客态。该文档的 Git blob 与调查使用的同版本镜像一致。
- 用户提供的 `quarkclouddrive-1.0.20.txt` 实际是 ZIP，SHA-256 为 `4e57e4328c80cf539caf518d6e773b4efee4a096f9822bf46acd0201762cfc24`，与先前调查使用的[第三方同版本镜像](https://github.com/HechaoYannet/minimax-h3/blob/e5d299f8ebccaee02ef520189c3c6acf2895c523/web_disk/quarkclouddrive-1.0.20.zip)字节一致；其中 CLI 的 SHA-256 为 `39aa12702181ef3736f61bfb3159a04dfe88371163fc1f53f1b9c22efa38be9f`。10 个官方仓库文档及安装、卸载脚本与附件内同名内容一致；官方仓库不含此 CLI 文件，故不能独立验证其文件哈希。由于本环境无法从夸克下载链接取得文件，也不能独立验证该附件与下载站文件完全一致。
- 在隔绝网络和宿主文件的临时环境中运行镜像 CLI：无登录信息时 `share-detail` 在命令入口返回未登录；使用**仅供模拟的虚构凭据和虚构 HTTP 响应**后，观察到以下请求路径和字段。文档所称客态与此 CLI 入口的登录检查存在差异，不能把模拟结果当作免登录实测。
- 已将用户附件手动解压到本环境的 `~/.agents/skills/quarkclouddrive`，未运行会联网更新和改动系统命令的安装脚本；隔离环境中的 `--version` 返回 `1.0.20-5be3987`。沙箱无法连接夸克开放平台和网盘服；隔离运行 `login` 时 CLI 也提示无法识别当前 Agent，因此**尚未完成真实 OAuth 授权**。CLI 包含诊断上报逻辑；不要为排查而上传原始对话、账号凭据或分享令牌。

## 调用顺序

### 1. 分享首页：取得列表与短期分享令牌

```http
POST https://drive-pc.quark.cn/1/clouddrive/share/sharepage/v2/detail
Content-Type: application/json
```

参数示意（真实请求应逐项 URL 编码）：

| 查询参数 | 含义 |
| --- | --- |
| `req_id` | 每次请求的随机 ID |
| `pr` / `fr` | Skill 请求中为 `ucpro` / `third` |
| `device_id` | Skill 默认客态设备标识为 `wild_claw` |
| `access_token` | SDK 的客态初始化代码使用字面量 `guest_placeholder`；这**不是账号令牌**，其在线可用性未验证。已授权 CLI 的实际值来自账号，不能公开或写入前端。 |

请求体示意，`passcode` 只在分享有提取码时提供：

```json
{
  "pwd_id": "分享链接 /s/ 后面的 ID",
  "passcode": "可选提取码",
  "page": 1,
  "size": 50,
  "fetch_total": 1,
  "fetch_share": 1
}
```

网盘服成功响应中，从 `data.detail_info.list` 读取首页条目，从 `data.token_info.stoken` 取得后续请求需要的**短期分享令牌**。每个条目的 `file_name` 为名称、`fid` 为文件或目录 ID；`file_type` 为 `0` 表示文件夹、`1` 表示文件。还可能有 `dir`、`size` 等字段。实际包络与分页元数据以服务响应为准；不能仅凭 HTTP 200 认定业务成功。

### 2. 翻页和进入子目录

```http
GET https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail
```

除上面的通用查询参数外，传 `pwd_id`、`stoken`、`pdir_fid`、`_page`、`_size`、`_fetch_total=1`、`_fetch_share=1`。根目录的 `pdir_fid` 为 `0`，进入文件夹时使用该文件夹条目的 `fid`；页码从 1 开始。列表在 `data.list`。

分页应优先参考响应中的对应目录总数和页大小；没有可信总数时，完整一页后继续请求下一页。`share.file_num` 可能是**整个分享**的总数，不能当作每个子目录的总数。递归时要限制请求数、深度和文件数，避免重复页或循环目录。

## 本项目的使用方式

`src/netdisk.js` 先尝试上面的候选客态首页和翻页路径，再兼容原有的 `/sharepage/token` + `/sharepage/detail` 路径；固定使用夸克主机，不跟随重定向，也不会传入账号 Cookie。首页、备用主机和分页尝试共用列表请求预算；结果只保留名称，不返回分享 ID、提取码、`stoken` 或 `fid`。如果首页可读但后续令牌不可用，会明确标记为部分目录。

后台 `POST /api/admin/netdisk/preview` 仅供已登录管理员调用，接受分享 URL 和可选提取码；管理员审核并保存后才对外显示名称快照。真实服务可能要求登录、拒绝数据中心 IP、需要额外参数或改变协议，失败时可查看脱敏诊断或手工填写。

`stoken` 在目录请求查询串中出现，因此不要记录完整上游 URL，也不要把它返回给浏览器或写进仓库。不要在聊天中提供密码、验证码、Cookie、授权码或 token。若以后要授权账号，应在确认程序来源和夸克授权页权限范围后，由用户直接在夸克页面操作；是否把账户凭据交给生产 Worker 是另一个独立的决定。
