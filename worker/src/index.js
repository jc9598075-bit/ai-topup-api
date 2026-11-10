// ai-topup-api — Cloudflare Workers（无依赖，纯 Web 标准 API）
// 用途：AI 代充价格查询 API + 问答，后端数据在 Supabase，前端是同目录 public/index.html。
//
// 免费额度与注意事项（部署前必读，见 README.md）：
// - Workers 免费档：每天 10 万次请求，每次最多 10ms CPU。/api/ask 每次调用都会调
//   OpenRouter，OpenRouter 免费模型限额是 50 次/天、20 次/分钟——真正卡脖子的是
//   OpenRouter 的 50 次/天，不是 Workers 的 10 万次。问答接口不要被刷。
// - Supabase 表 public.price_history 已开 RLS 且没有任何策略，匿名 key 读不到也
//   写不进，所以本 Worker 读写全部走 SUPABASE_SERVICE_ROLE_KEY（服务端专用），
//   这个 key 绝不能放进前端代码、也绝不能写进仓库，只能用 wrangler secret put 设置。
// - OpenRouter 免费模型名单会变，模型 ID 不要写死：用环境变量 FREE_MODEL 配置，
//   默认留空；去 https://openrouter.ai/models?max_price=0 挑一个当时免费的填。

const SUPABASE_TABLE = 'price_history';

// ---- CORS：查询页和 API 同域部署，CORS 主要是给跨域调试/外部调用留的口子 ----
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function err(message, status = 500) {
  return json({ ok: false, error: message }, status);
}

// ---- /api/ask 的简易限流（尽力而为版）----
// Worker 实例之间不共享内存，这个计数器只在单个 isolate 内有效，只能挡住
// 同一实例内的连续刷请求，不能当精确的每日配额用。真正的 50 次/天上限由
// OpenRouter 侧执行，超了 OpenRouter 会返回 429，本接口会把 429 原样透传。
// 想精确限流要接 Workers KV / Durable Objects，那是付费档才划算的做法，免费
// 方案里不做。
let askCount = 0;
let askDay = '';
function askRateLimitExceeded() {
  const today = new Date().toISOString().slice(0, 10); // UTC 日期
  if (today !== askDay) {
    askDay = today;
    askCount = 0;
  }
  askCount += 1;
  // 留一点余量：单实例每天最多放行 40 次问答，剩下的额度留给重试/波动。
  return askCount > 40;
}

// ---- Supabase REST 调用（服务端专用 key，只在 Worker 里用）----
function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// 取某个商品各店的最新一条价格记录。返回 [{ shop, product, price_cny, checked_at }]
async function fetchLatestPrices(env, product) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}` +
    `?select=shop,product,price_cny,checked_at` +
    `&product=eq.${encodeURIComponent(product)}` +
    `&order=checked_at.desc&limit=200`;
  const res = await fetch(url, { headers: supabaseHeaders(env) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase 查询失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  const rows = await res.json();
  // 按 checked_at 倒序，同一家店只保留第一条（即最新一条）
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.shop)) latest.set(row.shop, row);
  }
  return [...latest.values()].sort((a, b) => Number(a.price_cny) - Number(b.price_cny));
}

export default {
  async fetch(request, env) {
    // 预检请求直接放行
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---------- GET /api/prices?product=Plus ----------
      // 返回各店最新价，按价格从低到高排。
      if (path === '/api/prices' && request.method === 'GET') {
        const product = url.searchParams.get('product') || 'Plus';
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
          return err('服务端未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', 500);
        }
        const prices = await fetchLatestPrices(env, product);
        return json({ ok: true, product, count: prices.length, prices });
      }

      // ---------- GET /api/cheapest?product=Plus ----------
      // 返回最便宜的一家（没有数据时 cheapest 为 null）。
      if (path === '/api/cheapest' && request.method === 'GET') {
        const product = url.searchParams.get('product') || 'Plus';
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
          return err('服务端未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', 500);
        }
        const prices = await fetchLatestPrices(env, product);
        return json({ ok: true, product, cheapest: prices[0] || null });
      }

      // ---------- POST /api/prices ----------
      // 请求体：{ "shop": "店名", "product": "Plus", "price_cny": 123.45 }
      // checked_at 不用传，表里默认 now()。写操作同样走 service_role key。
      // 鉴权：必须带写入密钥，任一方式均可——
      //   Authorization: Bearer <WRITE_SECRET> 或请求头 x-write-secret: <WRITE_SECRET>
      // WRITE_SECRET 用 wrangler secret put WRITE_SECRET 设置，绝不写进文件。
      // 未配置时直接拒绝写入（fail-closed），避免无密钥部署后被人往库里写脏数据。
      if (path === '/api/prices' && request.method === 'POST') {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
          return err('服务端未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY', 500);
        }
        if (!env.WRITE_SECRET) {
          return err('服务端未配置 WRITE_SECRET，写入接口已关闭', 503);
        }
        const auth = request.headers.get('Authorization') || '';
        const headerSecret = request.headers.get('x-write-secret') || '';
        if (auth !== `Bearer ${env.WRITE_SECRET}` && headerSecret !== env.WRITE_SECRET) {
          return err('写入密钥不对', 403);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return err('请求体不是合法 JSON', 400);
        }
        const { shop, product, price_cny } = body || {};
        if (typeof shop !== 'string' || !shop.trim()) {
          return err('缺少字段：shop（店名）', 400);
        }
        if (typeof product !== 'string' || !product.trim()) {
          return err('缺少字段：product（商品名）', 400);
        }
        const price = Number(price_cny);
        if (!Number.isFinite(price) || price <= 0) {
          return err('price_cny 必须是大于 0 的数字', 400);
        }
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
          method: 'POST',
          headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
          body: JSON.stringify({
            shop: shop.trim(),
            product: product.trim(),
            price_cny: price,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return err(`写入 Supabase 失败（HTTP ${res.status}）：${text.slice(0, 200)}`, 502);
        }
        const inserted = await res.json();
        return json({ ok: true, inserted: inserted[0] || null }, 201);
      }

      // ---------- GET /api/ask?q=现在最便宜的Plus是哪家 ----------
      // 用 OpenRouter 免费模型，结合当天价格数据回答一句话。
      // 注意：每次调用消耗 1 次 OpenRouter 免费额度（50 次/天、20 次/分钟）。
      if (path === '/api/ask' && request.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return err('缺少参数：q（问题）', 400);
        if (!env.OPENROUTER_API_KEY) {
          return err('服务端未配置 OPENROUTER_API_KEY', 500);
        }
        if (!env.FREE_MODEL) {
          return err(
            '服务端未配置 FREE_MODEL：去 OpenRouter 免费模型页挑一个模型 ID，wrangler secret put FREE_MODEL 或在 wrangler.toml 的 [vars] 里填',
            500,
          );
        }
        if (askRateLimitExceeded()) {
          return err('问答接口今天的免费额度已用完（OpenRouter 免费模型每天 50 次），明天再问', 429);
        }
        // 先取价格数据（默认按问题里的商品，没有就按 Plus）
        const product = /Go|Pro|Team|Plus/i.test(q) ? q.match(/Go|Pro|Team|Plus/i)[0] : 'Plus';
        let prices = [];
        if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
          try {
            prices = await fetchLatestPrices(env, product);
          } catch (e) {
            // 价格取不到不影响问答，把错误写进提示词让模型说明
            prices = [];
            console.warn('取价格数据失败：', e.message);
          }
        }
        const priceText =
          prices.length > 0
            ? prices
                .map((p) => `${p.shop}：¥${p.price_cny}（${p.checked_at} 更新）`)
                .join('；')
            : '暂无价格数据';
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            // OpenRouter 要求注明来源，免费档不强制但建议写
            'HTTP-Referer': url.origin,
            'X-Title': 'ai-topup-api',
          },
          body: JSON.stringify({
            model: env.FREE_MODEL,
            messages: [
              {
                role: 'system',
                content:
                  '你是一个 AI 代充价格助手。只根据下面给的价格数据回答，用一句话、中文、直接给结论；没有数据就明说没有数据，不要编价格。',
              },
              {
                role: 'user',
                content: `问题：${q}\n最新价格数据（${product}）：${priceText}`,
              },
            ],
            max_tokens: 200,
            temperature: 0,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          // 429 一般是 OpenRouter 免费限额到了，原样告诉调用方
          return err(`OpenRouter 调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`, res.status === 429 ? 429 : 502);
        }
        const data = await res.json();
        const answer = data?.choices?.[0]?.message?.content?.trim() || '';
        return json({
          ok: true,
          q,
          product,
          model: env.FREE_MODEL,
          answer,
          prices,
        });
      }

      // 其他路径：/ 走静态页（wrangler assets），其余返回 404
      return err(`未知接口：${request.method} ${path}`, 404);
    } catch (e) {
      console.error(e);
      return err(`服务器内部错误：${e.message || e}`, 500);
    }
  },
};
