// 本地导入脚本：把价格数据逐条 POST 到 Worker 的 /api/prices。
// 用法：
//   1. 把价格数据写进同目录的 prices.json（数组，每项 { shop, product, price_cny }）。
//      没有 prices.json 时可以先复制 prices.example.json 改名，但示例文件里
//      是假数据，必须替换成真实价格再跑。
//   2. 设置环境变量后运行：
//        WORKER_URL=https://ai-topup-api.<子域>.workers.dev \
//        WRITE_SECRET=<写入密钥> \
//        node scripts/import-prices.mjs
//
// 注意：
// - Worker 地址和密钥只从环境变量读，不要写死、不要把密钥写进文件。
// - WRITE_SECRET 和 Worker 端 `wrangler secret put WRITE_SECRET` 设置的是
//   同一个值，两边名字相同、值也相同，部署时别填岔了
//   （见 worker/src/index.js 的鉴权逻辑）。
// - prices.json 接受两种格式：裸数组，或 { "prices": [ ... ] } 对象
//   （后者是为了让 prices.example.json 复制后不用改结构也能跑）。
// - Node 18+ 自带全局 fetch，不需要装依赖。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICES_FILE = path.join(__dirname, 'prices.json');

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const WRITE_SECRET = process.env.WRITE_SECRET || '';

if (!WORKER_URL) {
  console.error('缺少环境变量 WORKER_URL：部署后的 Worker 地址，例如 https://ai-topup-api.<子域>.workers.dev');
  process.exit(2);
}
if (!WRITE_SECRET) {
  console.error('缺少环境变量 WRITE_SECRET：写入密钥（值必须等于 Worker 的 WRITE_SECRET）。');
  process.exit(2);
}

let raw;
try {
  raw = await readFile(PRICES_FILE, 'utf-8');
} catch {
  console.error(
    `读不到 ${PRICES_FILE}：先把价格数据写进 prices.json（数组，每项 { shop, product, price_cny }），` +
      '可以复制 prices.example.json 改名，但里面的示例数据必须替换成真实价格。',
  );
  process.exit(2);
}

let items;
try {
  const parsed = JSON.parse(raw);
  items = Array.isArray(parsed) ? parsed : parsed.prices;
} catch {
  console.error('prices.json 不是合法 JSON。');
  process.exit(2);
}
if (!Array.isArray(items) || items.length === 0) {
  console.error('prices.json 里没有价格数据（需要一个非空数组，每项 { shop, product, price_cny }）。');
  process.exit(2);
}

let okCount = 0;
let failCount = 0;
for (const [i, item] of items.entries()) {
  const shop = typeof item?.shop === 'string' ? item.shop.trim() : '';
  const product = typeof item?.product === 'string' ? item.product.trim() : '';
  const price = Number(item?.price_cny);
  if (!shop || !product || !Number.isFinite(price) || price <= 0) {
    console.error(`第 ${i + 1} 条数据不合法，已跳过：${JSON.stringify(item)}`);
    failCount += 1;
    continue;
  }
  try {
    const res = await fetch(`${WORKER_URL}/api/prices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WRITE_SECRET}`,
      },
      body: JSON.stringify({ shop, product, price_cny: price }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`写入失败：${shop} / ${product} / ${price}（HTTP ${res.status}）：${text.slice(0, 200)}`);
      failCount += 1;
    } else {
      console.log(`已写入：${shop} / ${product} / ${price}`);
      okCount += 1;
    }
  } catch (e) {
    console.error(`写入失败：${shop} / ${product} / ${price}：${e.message}`);
    failCount += 1;
  }
}

console.log(`\n完成：成功 ${okCount} 条，失败 ${failCount} 条。`);
if (failCount > 0) process.exit(1);
