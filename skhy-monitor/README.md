# SKHY Monitor

独立的只读监控：读取 Kraken Futures `PF_SKHYUSD` 和 Gate Futures `SKHYNIX_USDT` 的官方公开盘口，计算约 6,000 U/边的可成交价差和 CrossEx 应填写的数量，然后通过 Telegram 发送必要提醒。

它不连接 Gate CrossEx，不保存交易所 API Key，不下单、不平仓、不转账。

## 本地检查

需要 Node.js 20 或更新版本：

```powershell
npm test
npm run once
```

`npm run once` 只读官方公开盘口并打印一次建议数量，不发送 Telegram 消息。

## Telegram 配置

在本目录新建 `.env` 文件，只放下面两行；这个文件已加入忽略列表，不会被提交：

```dotenv
TELEGRAM_BOT_TOKEN=你的Bot Token
TELEGRAM_CHAT_ID=你的Chat ID
TELEGRAM_THREAD_ID=你的话题ID
```

设置流程：

1. 在 Telegram 中搜索 `@BotFather`，创建机器人并复制 Token。不要把 Token 发到聊天里。
2. 打开你新建的机器人，点击 `Start`，给它发送一条 `/start`。
3. 先在 `.env` 里只填写 `TELEGRAM_BOT_TOKEN`，运行 `npm run telegram-check` 检查连接，再运行 `npm run chat-id` 得到 Chat ID。
4. 把群 Chat ID 和目标话题 ID 填入 `.env`，然后运行 `npm start`。

如果使用群组话题，`npm run chat-id` 会同时显示 `chatId` 和 `threadId`。把 `threadId` 填入 `TELEGRAM_THREAD_ID`，监控消息就会固定发送到该话题；不填写则发送到私聊或群组的通用位置。

如果 `npm run chat-id` 显示没有收到消息，先确认你是在新建的机器人聊天窗口里点击了 `Start`，再重试。

可选：复制 `config.example.json` 为自己的配置文件，并设置：

```text
MONITOR_CONFIG=/opt/skhy-monitor/config.json
MONITOR_STATE_PATH=/opt/skhy-monitor/data/state.json
```

启动：

```bash
npm start
```

## Telegram 指令

```text
/entered 1   已手动开第 1 档，开始跟踪该档止盈
/closed 1    已手动平第 1 档，停止该档止盈提醒
/status      查询状态
/pause       暂停机会提醒
/resume      恢复机会提醒
```

## 提醒策略

- 只在两次连续检查都达到阈值时提醒，默认每 5 秒检查一次。
- 开仓提醒直接写 `每笔订单数量` 和 `最大仓位`，方便照填 Gate CrossEx。
- Gate 对冲数量同时显示币数和合约张数。
- 价差持续满足时不重复发送；回落超过 0.3 个百分点后才重新等待触发。
- 没有新机会时不发送行情流水、心跳或日报。
- 只有连续 3 次无法取得官方盘口时才发送故障提醒。
- 止盈提醒只对你用 `/entered` 标记过的档位发送。

## VPS

将目录放到 `/opt/skhy-monitor`，把环境变量放入 `/etc/skhy-monitor.env`，权限设为仅服务用户可读，再安装 `skhy-monitor.service.example` 为 systemd 服务。只需允许 VPS 出站访问 Kraken、Gate 和 Telegram，不需要开放入站端口。
