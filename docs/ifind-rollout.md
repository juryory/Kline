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
盘后任务按 15:30—21:00 每 15 分钟运行（`.env.docker` 的 `SYNC_WINDOW=15:30-21:00`，升级时记得改）；图表和设置中的最新日期可用于确认是否到数。

## 4. 盘中实时数据，后台补历史

盘中不再定时轮询，改为服务进程按需拉取：只有导播台 / 直播画面正在看的标的才请求，不看的不更新。
- 分时（含个股）：高频接口增量取当天已走完的分钟（与上一根重叠一根），写进 `ifind_minute`；盘后同步看到完整的一天直接跳过，不重复消耗。
  首次打开一个标的取当天全部分钟（约 1446 数据量、0.1 秒），之后每次只取新增几分钟。非交易时间打开没看过的标的，补取上一交易日。
- 日K：实时行情拼出今天这根，只在内存里，不入库；正式日线由盘后同步写入。分钟 K（指数 / 板块 / ETF）同样接上当天分钟。
- 刷新：分时每 30 秒（`INTRADAY_REFRESH_MS`），日K / 分钟 K / 排行每分钟；同一标的 20 秒内最多请求一次。
- 午休、收盘后沿用当天数据，直到盘后同步写入当天日线；节假日按交易日历（`get_trade_dates`，不耗额度）取上一交易日。
- 每个被查看的标的一天约 5000 数据量，记入本地周额度账本（kind = live_minute / realtime）。
- 个股分钟 K（5/15/30/60 分）需要历史分钟，暂不提供。

历史补齐在收盘窗口外手动运行：

```bash
docker compose exec kline npm run sync:ifind -- --backfill --dry-run
docker compose exec kline npm run sync:ifind -- --backfill
```

每轮受请求数、运行时间和周预算限制，`deferred=true` 表示暂停在断点，下轮同命令继续。
已完成日期不再请求；已有 Tushare 日线直接复用。当前不自动调度长期历史任务，可在服务器另行安排窗口。
缺失节假日/停牌数据不算完成，日志可能报告待补；不能把所有 pending 都理解为接口故障。

## 5. 宏观数据

盘后的 iFinD 同步完成后，会接着从经济数据库（EDB）拉宏观数据，写入 `ifind.db` 的 `ifind_macro` 表。
EDB 有独立的每周 500 万额度，不占用行情额度。首次拉取 `IFIND_MACRO_YEARS` 年（默认 5 年），约 3 万数据量；
之后每次从已有的最新一期往前回看一段（日频 30 天、月度 400 天、季度 800 天），覆盖统计局的修订值。
指标 ID 与 tushare 字段的对应见 `shared/macro.js` 的 `MACRO_EDB`。没映射的指标和更早的历史由 Tushare 主库补，
所以盘后的 Tushare 同步仍需保留。

```bash
# 只拉宏观，不请求行情
docker compose exec kline npm run sync:ifind -- --macro-only
```

## 6. 同花顺概念排行

iFinD 模式下，「同花顺概念」排行全部用 iFinD 的数据：
- 板块列表：板块树「概念类 → 常规概念」（报表 `p03321`，节点 `001042`）。新兴概念、其他概念没有编制指数，不参与排行。
  板块树只给节点 ID，指数代码（885xxx / 886xxx.TI）按名称用 `get_thscode` 查，结果缓存在 `ifind_boards`。
- 成分股：报表 `p03291`，存 `ifind_members`。
- 涨停数：个股日线顺带取 `ths_up_and_down_status_stock`，存 `ifind_limit_up`。
- 板块日线：iFinD 优先，iFinD 没同步到的更早日期用 Tushare 补。
- 主力净额：iFinD 没有对应的板块资金流，不展示。

列表和成分股每周刷新一次，放在日常同步的行情之前。首次约 3—4 分钟（要按名称查约 390 个代码），
之后只查新出现的名称；每次刷新约 8 万基础数据额度（每周 500 万）。手动刷新：

```bash
docker compose exec kline npm run sync:ifind -- --boards
```

上线当天的个股日线如果在本版本之前已同步，那天没有涨停状态，排行的涨停数显示 `--`，下一个交易日恢复。

盘中（9:30—11:30、13:00—15:00）排行用 iFinD 实时行情：一次请求取全部概念板块的最新价、涨跌幅、涨停家数，
5/10/20 日和年初至今用最新价对本地历史收盘价计算。只在导播台打开排行页或排行上屏时请求，
`IFIND_LIVE_RANK_MS`（默认 60000）内最多一次；每次约 1930 行情额度，按每分钟一次算一周约 230 万（周额度的 1.5%），
记入本地周额度账本（kind = realtime）。午休、收盘后沿用当天最后一次结果，直到盘后同步把当天日线写进库；
节假日接口返回上一交易日行情时不当作今天。请求失败或超过 3 秒时沿用上一次结果，没有则显示盘后数据。
盘中涨停数用的是同花顺官方的板块涨停家数，个别板块可能和盘后按成分股算的差 1。

## 7. 下一批再接海外与期货

候选清单见 `config/ifind-universe.example.json`。当前这些项 disabled，启用海外项会明确报不支持。
接下来逐类验证账号可访问代码、时区/夏令时、交易日历、夜盘及历史年限，再实现相应的展示和调度。
期货需先明确具体指数口径，不把主力连续合约当作期货指数。

回退时在设置切回 Tushare 本地库。两套原始行情独立保存，回退不会删除 iFinD 新数据。
