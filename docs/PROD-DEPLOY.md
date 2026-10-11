# 生产环境运维与零停机更新指南

本项目生产环境（`stronghold-protocol.priestess.icu`）部署在独立 Linux 服务器上，采用 **Caddy 反向代理 + Docker 双槽位蓝绿实例 (Blue-Green)** 架构，实现**全天候随时发布、零停服、对局零中断**的无缝更新。

---

## 1. 架构拓扑

```text
                             外部玩家 (HTTPS / WSS)
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │     Caddy 反代 (zoot-caddy)    │
                       │     (host 网络, 监听 443)      │
                       └───────────────┬───────────────┘
                                       │
                   ┌───────────────────┴───────────────────┐
                   ▼                                       ▼
        ┌──────────────────────┐                ┌──────────────────────┐
        │   stronghold-blue    │                │   stronghold-green   │
        │   端口: 3010          │                │   端口: 3011          │
        │   容器名: stronghold  │                │   容器名:            │
        │           -blue      │                │   stronghold-green   │
        └──────────────────────┘                └──────────────────────┘
```

- **活跃槽位（Active）**：接收所有新连接与新房间。
- **排空槽位（Draining）**：切换后仅托管存量对局，等待局内玩家打完并随前端 `buildGuard` 自然刷新迁出。
- **监控解耦**：`zoot-metrics` 通过 `https://stronghold-protocol.priestess.icu/healthz` 始终采集当前活跃容器，切服过程不中断。

---

## 2. 一键更新命令

在本地开发机根目录下，直接执行：

```bash
# 一键部署更新（默认自动增量同步素材与代码 -> 构建目标镜像 -> 切换 Caddy -> 等待旧容器排空关闭）
npm run deploy:prod
# 或
./scripts/deploy-prod.sh
```

### 常用运维操作

```bash
# 查看当前活跃槽位、端口与对局/在线人数
./scripts/deploy-prod.sh --status

# 查看全服详细实时战况（每个房间模式/难度/当前第几回合/处于什么阶段/席位玩家与血量）
./scripts/deploy-prod.sh --matches

# 快速发布（Caddy 切换后立即退出命令行，让旧容器在后台自然陪玩家打完并销毁）
./scripts/deploy-prod.sh --no-wait

# 紧急秒级回滚（Caddy 路由瞬间切回另一颜色实例）
./scripts/deploy-prod.sh --rollback
```

---

## 3. 工作原理（为什么能零中断？）

1. **构建与自检**：脚本在空闲端口（如 3011）构建并启动新容器，轮询 `/healthz` 确认新版本完全就绪（若失败则自动熔断，不影响现网）。
2. **Caddy 优雅重载**：修改 Caddyfile 并触发重载。Caddy 保证**现存 WebSocket 长连接不断**，新进入的连接直接打到新容器。
3. **前端配合自然排空**：
   - 大厅闲置玩家：60 秒内检测到新指纹，自动静默刷新进新容器；
   - 战斗中玩家：`buildGuard` 压制刷新，保留在老容器把当前对局打完；
   - 结算返回大厅时：瞬间触发刷新，自然平滑迁移到新容器。
4. **资源安全回收**：脚本监控老容器的 `sockets`，归零后自动执行 `docker stop` 释放端口与内存。

---

## 4. 关键文件索引

| 文件 | 用途 |
|---|---|
| `scripts/deploy-prod.sh` | 生产环境专用一键部署脚本（包装本地/远端编排） |
| `tools/deploy-bluegreen.mjs` | 蓝绿切换核心工具（构建、探活、Caddy 重载、排空监控） |
| `docker-compose.yml` | 蓝绿双槽位服务声明（`stronghold-blue` / `stronghold-green`） |
| `findings/blue-green-deployment.md` | 详细技术设计与测试验证记录 |
| `tools/maintenance.mjs` | （可选备用）计划停服公告与滚动横幅管控工具 |
