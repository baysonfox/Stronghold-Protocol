# 补齐生产服务器与本地多语言语音素材记录

## 1. 背景与排查

在 0.3.0 版本中，客户端正式引入了对英语（`voiceEn`）、韩语（`voiceKr`）以及干员母语/方言配音（`voiceNative`，如德克萨斯意语、白面鸮方言等）的支持，并在 `data/assets.json` 中完整建立了语音清单。

但在生产服务器（`origin.priestess.icu`）与本地环境中，`public/assets/audio/voice/` 下此前仅下载并存放了国语（`cn`）和日语（`jp`）语音，其余语言目录缺失。

### 素材缺失盘点
通过对 `data/assets.json` 进行全树遍历与文件系统比对，核实总资产条目为 18,682 个，发现缺失的文件全部位于 `assets/audio/voice` 目录下，共计 5,712 个音频文件：
- **英语语音（EN）**：2,548 个文件，位于 `audio/voice/en/`
- **韩语语音（KR）**：2,548 个文件，位于 `audio/voice/kr/`
- **干员母语/方言语音（Native）**：616 个文件，位于 `audio/voice/native/`

## 2. 上游素材源与路径映射

上游语音仓库为 ArknightsAssets2 的 `voice` 分支：
`https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/`

URL 与本地相对路径映射规范如下：
1. **英语**：
   - 客户端路径：`/assets/audio/voice/en/<char_id>/<voice_file>.mp3`
   - 上游源地址：`.../sound_beta_2/voice_en/<char_id>/<voice_file>.mp3`
2. **韩语**：
   - 客户端路径：`/assets/audio/voice/kr/<char_id>/<voice_file>.mp3`
   - 上游源地址：`.../sound_beta_2/voice_kr/<char_id>/<voice_file>.mp3`
3. **干员母语/方言**：
   - 客户端路径：`/assets/audio/voice/native/<char_id_dub>/<voice_file>.mp3`
   - 上游源地址：`.../sound_beta_2/voice_custom/<char_id_dub>/<voice_file>.mp3`

## 3. 实现与下载流程

针对 5,712 个小音频文件（总大小约 168.7 MB），直接在具备优质国际网络连接的生产服务器上执行并发下载，能够避免本地跨国宽带限制，大幅提高效率。

为此编写了高并发下载脚本 `tools/fetch-voice-missing.mjs`：
- **并发控制**：默认 32~40 并发 Worker 池；
- **原子落盘**：先下载至临时文件，经大小和基础格式检验后执行原子 `rename`，避免任何不完整文件残留；
- **容错重试**：单文件支持最多 3 次指数退避重试，设置超时时间；
- **账本更新**：下载完成后自动合并增量记录至 `.cache/assets-ledger.json`。

## 4. 执行与验证结果

1. **服务器下载**：
   - 在生产服务器执行：`node tools/fetch-voice-missing.mjs --concurrency=40`
   - 用时：**48.6 秒**
   - 成功率：**5,712 / 5,712（100%，0 失败）**，下载总量 168.7 MB。
2. **全量资产校验**：
   - 再次遍历 `data/assets.json` 的 18,682 个资产，比对结果为：`{ total: 18682, missing: 0 }`。
3. **在线服务即时加载验证**：
   - 由于生产容器通过 Docker 卷挂载宿主机目录（`./public/assets:/app/public/assets:ro`），通过内部端口对运行中的游戏容器发起 HTTP 请求：
     - `/assets/audio/voice/en/char_102_texas/cn_019.mp3` -> `HTTP 200 OK (audio/mpeg)`
     - `/assets/audio/voice/kr/char_102_texas/cn_019.mp3` -> `HTTP 200 OK (audio/mpeg)`
     - `/assets/audio/voice/native/char_102_texas_ita/cn_019.mp3` -> `HTTP 200 OK (audio/mpeg)`
   - 容器服务无需重启即可即时向玩家提供新语音。
4. **本地双向同步**：
   - 通过 rsync 将远端补全的 `public/assets/audio/voice/{en,kr,native}` 与更新后的 `.cache/assets-ledger.json` 同步至本地开发环境；
   - 本地再次校验，同样达成 `{ total: 18682, missing: 0 }`。
