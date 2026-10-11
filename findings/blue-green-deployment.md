# 零停机蓝绿部署与热重载架构实现

## 1. 痛点与背景

游戏服务为单体内存状态机设计（房间、战斗和 WebSocket 长连接驻留在 Node.js 内存堆中）。
在传统的单一容器部署下，更新版本（重启容器）会导致：
1. **进行中的多人联防/深渊对局直接强断**，严重伤害玩家体验；
2. 运维人员必须苦等所有活跃局归零，甚至熬夜在凌晨低谷人工切服；
3. 更新过程中有 3~5 秒的服务不可用窗口，若新镜像启动失败可能导致线上服务完全瘫痪（无容灾缓冲）。

## 2. 核心架构：Caddy 蓝绿平滑热重载 (Blue-Green Deployment)

### 为什么选择这个方案？
- **上游代码变更：0 行**：完全不破坏游戏核心代码与开源协议，纯外围运维编排实现。
- **天然契合前端 `buildGuard` 机制**：
  - 大厅闲置玩家：60 秒内检测到新指纹，自动静默刷新进新容器（Green）；
  - 战斗中玩家：`buildGuard` 自动压制刷新，保留在老容器（Blue）把当前对局打完；
  - 终局结算返回大厅时：瞬间触发刷新，自然平滑迁移到 Green。
- **Caddy 原生 Graceful Reload**：
  - Caddy 执行配置重载时，**完全不会掐断已经建立的底层 WebSocket TCP 连接**；
  - 所有的全新 HTTP 请求与全新 WebSocket 握手瞬间流入新容器。
- **安全防线（Zero Blast Radius）**：
  - 目标容器启动后必须通过本地 `/healthz` 深度探测（确认返回 `ok: true` 且 build 指纹正确）；
  - 若目标容器启动失败，脚本自动熔断并回滚，Caddy 保持原样不动，现网服务零影响。

---

## 3. 部署拓扑与状态机

```text
                                  玩家请求 (HTTPS / WSS)
                                            │
                                            ▼
                              ┌───────────────────────────┐
                              │    Caddy (zoot-caddy)     │
                              │  reverse_proxy 127.0.0.1  │
                              └──────┬─────────────┬──────┘
                                     │ (旧长连接)    │ (新连接与刷新)
                  ┌──────────────────┘             └──────────────────┐
                  ▼                                                   ▼
      ┌──────────────────────────┐                        ┌──────────────────────────┐
      │   stronghold-blue        │                        │   stronghold-green       │
      │   端口 3010 (旧版本)      │                        │   端口 3011 (新版本)      │
      │                          │                        │                          │
      │ • 承载正在打的存量对局   │                        │ • 承载新进大厅/新对局    │
      │ • 打完后前端自动刷新离开 │                        │ • 健康运行中             │
      │ • sockets 自然归 0       │                        │                          │
      │ • 脚本检测到 0 即停机    │                        │                          │
      └──────────────────────────┘                        └──────────────────────────┘
```

### 端口约定与 Docker Compose

- **Blue**：`127.0.0.1:3010:3000`（容器名 `stronghold-blue`）
- **Green**：`127.0.0.1:3011:3000`（容器名 `stronghold-green`）
- `docker-compose.yml` 声明两个服务，镜像统一共享为 `stronghold-protocol:latest`。

---

## 4. 自动化运维工具 (`tools/deploy-bluegreen.mjs`)

脚本支持在本地开发机远程编排，也支持直接在宿主机本地执行。

### 常用命令

```bash
# 1. 查看当前线上蓝绿状态与 Caddy 路由
node tools/deploy-bluegreen.mjs --remote root@origin.priestess.icu --status

# 2. 一键远程同步并无缝发布（推荐）
# 会自动 rsync 本地代码和 assets 到远端 -> 构建新容器 -> 切换 Caddy -> 等待旧容器排空 -> 停止旧容器
node tools/deploy-bluegreen.mjs --remote root@origin.priestess.icu --sync

# 3. 快速发布（切换后不阻塞命令行，让旧容器后台自然排空）
node tools/deploy-bluegreen.mjs --remote root@origin.priestess.icu --sync --no-wait

# 4. 极端异常时一秒紧急回滚
node tools/deploy-bluegreen.mjs --remote root@origin.priestess.icu --rollback
```

---

## 5. 关键协同优化：解耦监控指标采集 (`zoot-metrics`)

生产机上运行的 `zoot-metrics` 定期采集中断问题已彻底解决：
- 原配置：硬编码采 `http://127.0.0.1:3010/healthz`，切服时会导致 3010 停机报警；
- 改造优化：将 `/root/zoot-welfare/metrics/.env` 中的 `STRONGHOLD_HEALTHZ_URL` 改为 `https://stronghold-protocol.priestess.icu/healthz`；
- 收益：采集器始终经由 Caddy 读取当前活跃容器的健康数据，完全解耦容器物理端口，切服期间指标采集无缝连续。
