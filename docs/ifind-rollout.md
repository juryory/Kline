# iFinD 第一版服务器上线步骤

第一版范围：境内指数、行业/概念、ETF 日线与分钟；个股日线。新库保存 iFinD，旧库提供历史缺口。
代码测试通过不等于官方账户的标的权限通过；服务器先跑样本，再扩大范围。此文命令在服务器运行。

## 1. 保留现有数据库，配置新账号

部署新代码前备份现有持久卷。不要删除 `market.db`，不要直接复制正在写入的 SQLite 单个主文件。
沿用原来的 `.env.docker`，增补以下配置，不要用模板覆盖现有鉴权配置：

```dotenv
IFIND_REFRESH_TOKEN=在服务器填入新账号的RefreshToken
IFIND_DB_PATH=/data/ifind.db
IFIND_QUOTA_PROFILE=trial
IFIND_WEEKLY_BUDGET=150000000
IFIND_HISTORY_BUDGET=100000000
IFIND_RESERVE_BUDGET=20000000
IFIND_HISTORY_YEARS=5
IFIND_MAX_REQUESTS=2000
IFIND_MAX_SECONDS=600
IFIND_INTRADAY_ENABLED=0
```

Refresh Token 不是之前 FFD 的 API Key。若官方本周已用额度较多，先降低周预算；本地账本不知道其他客户端的消耗。
`IFIND_HISTORY_YEARS` 要与新账号实际历史权限一致，1.5 亿配额本身不证明开放上市以来全部数据。
旧库中已有的更早日线仍可直接显示。

```bash
docker compose up -d --build
```

## 2. 先验证单日样本

下面的 `2026-10-19` 是示例已收盘交易日；执行时换成要验证的实际交易日。
先验证一个指数、ETF、股票，再从项目现有列表选一个行业、一个概念、一只申万指数逐个验证。
板块的本地代码和 iFinD 官方代码可能不同，按 README 配 `IFIND_CODE_MAP_FILE`，不能猜后缀。

```bash
# 不访问行情接口，先看本轮计划
docker compose exec -e IFIND_SYMBOLS=000001.SH,510300.SH,600000.SH \
  -e IFIND_START_DATE=2026-10-19 -e IFIND_END_DATE=2026-10-19 \
  kline npm run sync:ifind -- --dry-run

# 最多3次行情请求：少量真实验证
docker compose exec -e IFIND_SYMBOLS=000001.SH,510300.SH,600000.SH \
  -e IFIND_START_DATE=2026-10-19 -e IFIND_END_DATE=2026-10-19 \
  -e IFIND_MAX_REQUESTS=3 kline npm run sync:ifind
```

核对价格、成交量、成交额单位及分钟时间戳。个股只应请求日线。
板块若无权限/返回空数据，先保持未启用或修正映射，不直接扩大为全市场请求。
ETF 的三位小数应保留；日线入库单位是手/千元，分钟入库单位是股/元。

## 3. 上线测试界面，再扩展数据

管理员进入「设置 → 行情数据源」，切换到 iFinD。旧库历史立即可用；缺分钟时显示缺数据，不会自动批量下载。
查看指数、股票和 ETF 的日线，再看已验证样本的分时；当天完整分时需要前一交易日的日线用于昨收。

```bash
# 默认最近7个自然日，完成项跳过；范围是现有境内标的池
docker compose exec kline npm run sync:ifind
```

先完成当天日线和重点指数分钟即可进入测试，不用等待半年全量。
全量前清空 `.env.docker` 中样本专用的 `IFIND_SYMBOLS` 和临时起止日期，并重建容器以更新环境。
需要分批上线时，保留已验证代码白名单，逐批扩大。
盘后任务继续按 18:15—21:00 每15分钟运行；图表和设置中的最新日期可用于确认是否到数。

## 4. 开启盘中更新，后台补历史

真实样本通过后设置 `IFIND_INTRADAY_ENABLED=1`，可先设置
`IFIND_INTRADAY_SYMBOLS=000001.SH,000300.SH` 仅更新重点指数，再 `docker compose up -d` 重建配置。
这是分钟增量轮询；未实现逐笔行情或秒级最新价订阅。历史补齐与盘中共用写锁，收盘窗口外手动运行：

```bash
docker compose exec kline npm run sync:ifind -- --backfill --dry-run
docker compose exec kline npm run sync:ifind -- --backfill
```

每轮受请求数、运行时间和周预算限制，`deferred=true` 表示暂停在断点，下轮同命令继续。
已完成日期不再请求；已有 Tushare 日线直接复用。当前不自动调度长期历史任务，可在服务器另行安排窗口。
缺失节假日/停牌数据不算完成，日志可能报告待补；不能把所有 pending 都理解为接口故障。

## 5. 下一批再接海外与期货

候选清单见 `config/ifind-universe.example.json`。当前这些项 disabled，启用海外项会明确报不支持。
接下来逐类验证账号可访问代码、时区/夏令时、交易日历、夜盘及历史年限，再实现相应的展示和调度。
期货需先明确具体指数口径，不把主力连续合约当作期货指数。

回退时在设置切回 Tushare 本地库。两套原始行情独立保存，回退不会删除 iFinD 新数据。
