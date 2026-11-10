#!/usr/bin/env bash
# 把 seed-2026-11-09-1255.json 的价格逐条写进已部署的 Worker（POST /api/prices）。
# 用法：先部署，再设好下面两个变量后执行：
#   BASE_URL=https://ai-topup-api.<你的子域>.workers.dev WRITE_SECRET=<部署时设的密钥> bash seed/seed.sh
# WRITE_SECRET 只从环境变量读，绝不要写进文件、不要发到聊天里。
set -euo pipefail
: "${BASE_URL:?请先设 BASE_URL，如 https://ai-topup-api.xxx.workers.dev}"
: "${WRITE_SECRET:?请先设 WRITE_SECRET（部署时 wrangler secret put 的那个值）}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
jq -c '.records[]' "$SCRIPT_DIR/seed-2026-11-09-1255.json" | while read -r rec; do
  curl -sS -X POST "$BASE_URL/api/prices" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $WRITE_SECRET" \
    -d "$rec" | head -c 300
  echo
done
echo "写完后用 curl \"$BASE_URL/api/prices?product=Plus\" 核对。"
