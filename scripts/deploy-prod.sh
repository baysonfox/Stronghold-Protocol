#!/usr/bin/env bash
# scripts/deploy-prod.sh — 生产环境一键零停机蓝绿更新脚本
#
# 用法:
#   ./scripts/deploy-prod.sh           # 默认：同步本地代码/素材，执行零停机蓝绿发布
#   ./scripts/deploy-prod.sh --status  # 查看生产环境当前活跃实例与 Caddy 路由状态
#   ./scripts/deploy-prod.sh --matches # 查看全服实时战况 (房间/难度/回合/阶段/玩家)
#   ./scripts/deploy-prod.sh --rollback# 紧急回滚：将 Caddy 瞬时切回另一实例
#   ./scripts/deploy-prod.sh --no-wait # 切换流量后立即退出，不阻塞等待旧容器排空

set -euo pipefail

PROD_HOST="root@origin.priestess.icu"
PROD_DIR="/root/Stronghold-Protocol"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 检查当前是否直接在生产服务器上运行
IS_ON_SERVER=false
if [[ -d "$PROD_DIR" && "$(pwd)" == "$PROD_DIR"* ]]; then
  IS_ON_SERVER=true
fi

cd "$REPO_ROOT"

if [[ "$IS_ON_SERVER" == "true" ]]; then
  echo "==> [生产宿主机本地模式] 执行更新..."
  node tools/deploy-bluegreen.mjs "$@"
else
  echo "==> [远程部署模式] 目标服务器: $PROD_HOST"
  # 若未传参或非仅查询参数，默认开启 --sync 进行增量同步
  EXTRA_ARGS=()
  HAS_ACTION=false
  for arg in "$@"; do
    if [[ "$arg" == "--status" || "$arg" == "-s" || "$arg" == "--rollback" || "$arg" == "-r" || "$arg" == "--matches" || "$arg" == "-m" ]]; then
      HAS_ACTION=true
    fi
  done

  if [[ "$HAS_ACTION" == "false" ]]; then
    EXTRA_ARGS+=("--sync")
  fi

  node tools/deploy-bluegreen.mjs --remote "$PROD_HOST" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} "$@"
fi
