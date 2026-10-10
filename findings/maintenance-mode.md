# 停服维护公告机制与滚动横幅设计

## 1. 背景与目标

游戏服务器为内存无状态设计，重启会强制中断所有正在进行的对局。
为了在更新和部署时将对玩家的影响降到最低，实现平滑排空与通知机制：
1. **全局维护公告机制**：支持设定在未来指定时间（如 30~40 分钟后）进行维护，支持自定义公告说明与取消计划；
2. **全端横幅与局内滚动提示**：
   - 网页端全界面顶部常驻倒计时横幅（`NoticeBanner`），进入对局时采用跑马灯横幅滚动显示；
   - 局内通过系统广播通道（`m.ticker`，最高优先级 100）定期播放滚动条提示与音效；
3. **重启前 10 分钟关闭新开局**：
   - 服务端拦截：`room.create` 和 `room.start` 硬拦截并返回 `ERR.MAINTENANCE`；
   - 客户端响应：大厅「创建同盟/开始模拟」与房间内「开始模拟」按钮禁用并展示维护说明，横幅切换为紧急警报样式。

---

## 2. 接口与运维工具

### HTTP 管理接口 (`/admin/maintenance`)

- `GET /admin/maintenance`：查询当前维护状态。
- `POST /admin/maintenance`：
  - 设置维护：`{ inMinutes: 30, message: "可选说明" }` 或 `{ deadline: timestamp }`
  - 取消维护：`{ cancel: true }`
- 鉴权逻辑：
  - 本机 Loopback（127.0.0.1 / ::1）默认允许直接操作；
  - 若配置了环境变量 `ADMIN_TOKEN` 或 `SP_ADMIN_KEY`，远程请求需携带 `Authorization: Bearer <token>` 或 `X-Admin-Token`。

### 监控接口 (`/healthz`)

`GET /healthz` 响应中新增 `maintenance` 字段：
```json
{
  "active": true,
  "deadline": 1791650000000,
  "remainingSec": 1800,
  "inCutoff": false,
  "cutoffSec": 600,
  "message": "停服维护更新"
}
```

### 运维 CLI (`tools/maintenance.mjs`)

```bash
# 设定在 30 分钟后维护
node tools/maintenance.mjs --in 30 --msg "停服更新 v0.2.3"

# 查看当前维护状态
node tools/maintenance.mjs --status

# 取消维护计划
node tools/maintenance.mjs --cancel
```

---

## 3. 核心机制流程

```text
运维执行设置 (tools/maintenance.mjs --in 30)
      │
      ▼
服务端 Lobby 更新状态 ───► 全体在线客户端广播 { t: 'notice', ... }
      │               ───► 局内所有活跃对局发送 m.ticker (Prio 100)
      │
      ├─► 倒计时进行中 (> 10 分钟)
      │     - 客户端顶部展示黄色警告横幅 + 实时倒计时
      │     - 局内跑马灯横幅持续滚动，并在整点分钟发送提示
      │     - 创建房间与开局正常允许
      │
      ├─► 进入截止期 (最后 10 分钟，inCutoff = true)
      │     - 横幅切换为红色紧急警报样式
      │     - 大厅「创建房间」禁用，提示「服务器即将维护，已停止创建房间」
      │     - 房间「开始模拟」禁用，提示「维护倒计时中，已停止开启新对局」
      │     - 服务端硬拦截 room.create 与 room.start，返回 ERR.MAINTENANCE
      │     - 进行中的对局不受影响，玩家可继续打完
      │
      ▼
维护时间到达 / 排空完成 ───► 安全重启服务器
```
