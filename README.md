# AI 代充价格 API + 查询页（A 方案）

Cloudflare Workers 提供价格查询 API，静态查询页随 Worker 同域部署。
数据存在 Supabase，问答走 OpenRouter 免费模型。

## 部署前准备（用户要做的事）

1. **Cloudflare 邮箱验证**：打开 `jc9598075@gmail.com` 的收件箱，找到 Cloudflare
   发来的验证邮件，点里面的链接完成验证。没验证通过，Workers 套餐页和 R2 页
   都会被拦在验证页，部署不了。
2. **三个密钥**（部署时设置，绝不要写进任何文件、不要发到聊天里）：
   - `SUPABASE_SERVICE_ROLE_KEY`：Supabase 项目 `ai-topup-prices` 的 service_role
     key（控制台 Settings → API 里找）。表 `public.price_history` 开了 RLS 且
     没有任何策略，匿名 key 读不到也写不进，所以读写必须走 service_role key，
     且只能在 Worker 服务端用。
   - `OPENROUTER_API_KEY`：OpenRouter 控制台里已有的 Default key。
     注意：密钥值只在控制台里看一眼，不要复制进文件。
   - `WRITE_SECRET`：写入接口的共享密钥，自己定一串随机字符（部署时
     `wrangler secret put WRITE_SECRET` 设置）。`POST /api/prices` 必须带
     它才写得进，没配它时写入接口直接返回 503，防止陌生人往库里写脏数据。
3. **免费模型 ID**：去 https://openrouter.ai/models?max_price=0 挑一个当时
   免费的模型，把 ID 填进 `wrangler.toml` 的 `FREE_MODEL`（或用
   `wrangler secret put FREE_MODEL`）。免费模型名单会变，不要写死。

## 部署步骤

```bash
cd ai-topup-api
npm install -g wrangler   # 没装 wrangler 才需要
npx wrangler login        # 按提示在浏览器里登录 Cloudflare 账号
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put WRITE_SECRET
npx wrangler deploy
```

部署成功后会给一个 `https://ai-topup-api.<你的子域>.workers.dev` 地址，
打开就是查询页，`/api/*` 是接口。部署后先用 `seed/seed.sh` 把种子价格
（2026-11-09 12:55 那轮实测价，见 `seed/seed-2026-11-09-1255.json`）写进
库里，查询页才有数据可查；eggai 那轮打不开，种子里没放它，别用旧价充数。

## 接口用法

基础地址用部署后给的 workers.dev 域名，下面用 `https://ai-topup-api.example.workers.dev`
代替（部署后换成真实地址）。

### GET /api/prices?product=Plus — 各店最新价

```bash
curl "https://ai-topup-api.example.workers.dev/api/prices?product=Plus"
```

返回各店最新一条价格记录（按 `checked_at` 取每店最新），按价格从低到高排：

```json
{
  "ok": true,
  "product": "Plus",
  "count": 3,
  "prices": [
    { "shop": "店A", "product": "Plus", "price_cny": 88.5, "checked_at": "2026-11-09T06:00:00+00:00" }
  ]
}
```

### GET /api/cheapest?product=Plus — 最便宜的一家

```bash
curl "https://ai-topup-api.example.workers.dev/api/cheapest?product=Plus"
```

```json
{ "ok": true, "product": "Plus", "cheapest": { "shop": "店A", "product": "Plus", "price_cny": 88.5, "checked_at": "..." } }
```

没有数据时 `cheapest` 为 `null`。

### POST /api/prices — 写入一条价格记录

```bash
curl -X POST "https://ai-topup-api.example.workers.dev/api/prices" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WRITE_SECRET" \
  -d '{"shop": "店A", "product": "Plus", "price_cny": 88.5}'
```

`checked_at` 不用传，表里默认 `now()`。返回 201 和写入的记录。
写入必须带 `WRITE_SECRET`（`Authorization: Bearer …` 或请求头
`x-write-secret`），没配密钥时接口返回 503、密钥不对返回 403；
密钥值只存在 Worker 的 secret 里，不要写进文件、不要发到聊天里。

### GET /api/ask?q=现在最便宜的Plus是哪家 — 模型问答

```bash
curl "https://ai-topup-api.example.workers.dev/api/ask?q=%E7%8E%B0%E5%9C%A8%E6%9C%80%E4%BE%BF%E5%AE%9C%E7%9A%84Plus%E6%98%AF%E5%93%AA%E5%AE%B6"
```

模型只根据当天价格数据回答一句话，没有数据会明说没有，不编价格。
返回里带 `model`（用的模型 ID）和 `prices`（回答依据的价格数据）。

## 查询页

`public/index.html`：输入商品名（默认 Plus）点查询，显示各店最新价和最便
宜的一家；下面问答框调 `/api/ask`。页面用相对路径 `/api/...` 调用接口，
部署后同域可用，不用改地址。直接本地双击打开文件时接口不通，必须部署后
用线上地址访问。

## 免费额度与注意事项

- **Workers 免费档**：每天 10 万次请求，每次最多 10ms CPU。价格查询很轻，
  随便够用。
- **OpenRouter 免费模型**：50 次/天、20 次/分钟。`/api/ask` 每次调用消耗
  1 次，超了会返回 429。Worker 里有个单实例尽力而为的计数器（每天 40 次），
  精确限流要接 KV/Durable Objects，免费方案里不做。**没点头不要买 credits**
  （买满 $10 后免费模型限额变 1,000 次/天）。
- **Supabase 免费档**：500MB 数据库、1GB 文件存储、5GB 出站/月、最多 2 个
  活跃项目，闲置 1 周会暂停。暂停后接口会报错，用 GitHub Actions 每周 ping
  一次保活（另做）。
- **RLS**：`price_history` 表已开 RLS 且无策略，匿名 key 读写都会被拒。
  本项目读写全部走 `SUPABASE_SERVICE_ROLE_KEY`（服务端专用），**绝不能放
  进前端代码、不要写进仓库、不要发到聊天里**。
- **R2**：本方案第一版没用到 R2（价格历史直接放 Supabase 表里）。R2 免费
  10GB 存储，后续要存价格历史快照/静态资源时再接。
- **CORS**：所有接口都带 `Access-Control-Allow-Origin: *`，方便跨域调用。

## 文件清单

```
ai-topup-api/
├── worker/src/index.js   # Worker 主代码（无依赖）：4 个接口 + CORS + 错误处理
├── wrangler.toml         # name ai-topup-api；vars 只放 SUPABASE_URL 和 FREE_MODEL
├── public/index.html     # 静态查询页
├── .github/workflows/
│   ├── keepalive.yml     # 每周一 09:00 UTC ping Supabase 保活（只读）
│   └── price-refresh.yml # 每 5 小时抓价骨架（待接真实数据源）
├── scripts/
│   ├── import-prices.mjs # 本地导入脚本：读 prices.json 逐条 POST 到 Worker
│   └── prices.example.json # 示例数据（假数据，别直接导入）
├── seed/                 # 种子价格（2026-11-09 实测价）与导入脚本
└── README.md             # 本文件
```

## 待改进（部署跑通后再做，不阻塞第一版）

1. ~~给 `POST /api/prices` 加共享密钥校验，防止陌生人往库里写脏数据。~~
   已做（2026-11-09）：`WRITE_SECRET` 鉴权已加上，未配置时返回 503。
2. GitHub Actions 定时任务：骨架已写好（见下面“GitHub Actions（定时任务）”
   一节），keepalive 每周 ping 保活、price-refresh 每 5 小时抓价；还缺真实
   数据源接入，price-refresh 目前只跑占位步骤、不写库。
3. `GET /api/prices` 的价格数据量大了以后加缓存（Cache API），减少
   Supabase 查询次数。

## GitHub Actions（定时任务）

仓库和工作流都不依赖 Cloudflare，Cloudflare 部署卡住也不影响先准备好。

### 部署说明

1. 在 GitHub 上新建一个**公开仓库**（名字随便，例如 `ai-topup-api`），
   不要勾选初始化 README——本项目里已经有了。
2. 把 `ai-topup-api/` 里的全部内容推到这个仓库（工作流文件在
   `.github/workflows/` 里，推上去后 GitHub 会自动识别；不需要在本地
   装任何东西）。
3. 在仓库的 **Settings → Secrets and variables → Actions → New repository
   secret** 里填下面 4 个 Secret（值只填在 GitHub 里，绝不要写进文件、
   不要发到聊天里）：
   - `SUPABASE_URL`：Supabase 项目 URL，`https://cdndnjliwpyjrsamcibu.supabase.co`
   - `SUPABASE_ANON_KEY`：Supabase 的 anon / publishable key（只读权限，
     控制台 Settings → API 里找）。
   - `WORKER_URL`：部署后的 Worker 地址，例如
     `https://ai-topup-api.<你的子域>.workers.dev`（Cloudflare 部署完才有，
     没部署前先空着，price-refresh 跑起来也只是占位步骤）。
   - `WRITE_SECRET`：写接口的鉴权密钥，和 Worker 端 `wrangler secret put
     WRITE_SECRET` 设置的是同一个值，两边名字相同、值也相同，部署时别填岔了。
4. 推上去后可以在仓库的 **Actions** 页点 `workflow_dispatch` 手动跑一次
   验证，定时任务之后按 cron 自动跑。

### 两个工作流是干嘛的

- `keepalive.yml`：每周一 09:00 UTC 跑一次，用 anon key 调 Supabase
  REST 接口读 `price_history` 最新 1 条，只读不写。curl 失败也不阻塞
  （`|| true` + 最后 `exit 0`），一次网络抖动不会报红。
- `price-refresh.yml`：每 5 小时跑一次（00:00、05:00、10:00、15:00、
  20:00 UTC）。目前是骨架：第一步“抓取各店价格”只有占位，第二步“写入
  Worker”里的 curl 也是注释掉的模板——真实数据源还没接，在此之前跑
  起来不写任何数据、不编任何价格。

### Supabase 保活原理

Supabase 免费项目闲置 **1 周**没人用就会暂停，暂停后接口会报错、
查询页查不到价格。每周 ping 一次就是给项目制造一次真实的数据库访问，
让它不算“闲置”。保活读的是最新 1 条记录，读不到（比如表是空的、或者
RLS 挡住了 anon key 的读）也没关系，请求本身已经打到数据库了。
如果想让保活读到真实行，可以在 Supabase 里给 `price_history` 加一条
允许匿名 SELECT 的策略（可选，未做，不阻塞）。

### 本地批量导入

不想等定时任务时，可以手动导一轮价格：

```bash
# 1. 把价格写进 scripts/prices.json（数组，每项 { shop, product, price_cny }）
#    可以复制 scripts/prices.example.json 改名，但示例里是假数据，必须换成真实价格。
# 2. 设置环境变量后运行：
WORKER_URL=https://ai-topup-api.<你的子域>.workers.dev \
WRITE_SECRET=<写入密钥，和 Worker 的 WRITE_SECRET 同值> \
node scripts/import-prices.mjs
```

脚本会逐条 POST 到 Worker 的 `/api/prices`，最后打印成功/失败条数，
有失败就返回非 0。Worker 地址和密钥只从环境变量读，不写进文件。

### 当前未完成的事

- **Cloudflare 部署**：控制台标签页读不出来、登录态不稳，邮箱验证那步
  用户已点过链接，但 Worker 还没部署上去。等 Cloudflare 能正常登录后，
  按上面“部署步骤”跑 `wrangler deploy`，再把得到的 workers.dev 地址
  填进 GitHub Secrets 的 `WORKER_URL`。
- **免费模型选择**：`FREE_MODEL` 还是空的，部署前去
  https://openrouter.ai/models?max_price=0 挑一个当时免费的模型 ID
  填上（名单会变，别写死）。没选好之前 `/api/ask` 会返回 500，不影响
  查价接口。
