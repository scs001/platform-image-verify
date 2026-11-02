#!/usr/bin/env bash
# deploy-plaza.sh — 壹座·智能体素材广场 上机脚本（雷池 + Caddy 配方，同 yongyi/memory 家法）
#
# 用法：
#   scripts/deploy-plaza.sh bundle                    # 只打部署包（不发车）
#   scripts/deploy-plaza.sh <user@host> [目标目录]     # 导出→打包→上传→落位，并打印后续两步
#   PLAZA_DIR=/srv/plaza scripts/deploy-plaza.sh user@host
#
# 前置：本机 ssh <user@host> 免密可登录（密钥已装）；目标机有 tar。
# 雷池侧不需要仓库——它只反代上游；静态文件由雷池机本地 Caddy file_server 提供。

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?用法: scripts/deploy-plaza.sh <user@host|bundle> [目标目录]}"
PLAZA_DIR="${PLAZA_DIR:-${2:-/srv/agent-plaza-site}}"
BUNDLE="/tmp/agent-plaza-site.tar.gz"

echo "① 导出（G1 对账/G2 形状/G3 六 lint 全绿才发车；facet 断连自动退上次快照）..."
node scripts/plaza-export.mjs --out site-plaza/generated --allow-stale

echo "② 打包..."
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$BUNDLE" -C site-plaza index.html style.css script.js locales generated deploy
echo "   包: $BUNDLE ($(du -h "$BUNDLE" | cut -f1 | tr -d '\t'))"

[ "$TARGET" = "bundle" ] && { echo "（bundle 模式到此为止）"; exit 0; }

echo "③ 上传并落位 $TARGET:$PLAZA_DIR ..."
ssh "$TARGET" "mkdir -p '$PLAZA_DIR' 2>/dev/null || sudo mkdir -p '$PLAZA_DIR'"
scp -q "$BUNDLE" "$TARGET:/tmp/agent-plaza-site.tar.gz"
ssh "$TARGET" "tar -xzf /tmp/agent-plaza-site.tar.gz -C '$PLAZA_DIR' && ls '$PLAZA_DIR' | tr '\n' ' ' && echo"

cat <<EOF

④ 服务器上给本机 Caddyfile 追加一块（2026-11-03 已落位过一次：块已存在则跳过本步；重载用 caddy reload——该 unit 无 ExecReload，systemctl reload 会拒）：

   agent.finddatatech.cloud {
       root * $PLAZA_DIR
       encode gzip zstd
       header Cache-Control "public, max-age=300"
       file_server
   }

   重载：caddy reload --config /etc/caddy/Caddyfile（零停机；unit 无 ExecReload）

⑤ 雷池控制台 → 新增网站（唯一需要控制台凭据的一步，2026-11-03 待用户完成）：
   域名:  agent.finddatatech.cloud
   源站:  http://127.0.0.1:8080（与 zhiyu/yongyi 域同上游，照抄其网站条目）
   证书:  按 zhiyu 同法签发（Safeline 证书管理）
   （DNS A 记录已生效：agent → 103.236.89.212）

⑥ 验证（DNS 生效后）：
   curl -sI https://agent.finddatatech.cloud/ | head -3
   curl -s  https://agent.finddatatech.cloud/generated/counts.json
   curl -s  https://agent.finddatatech.cloud/generated/llms.txt | head -5
EOF
