# K 线直播图文包装

```
server/            数据层（Node）
  index.js         HTTP + WebSocket，导播状态、行情推送、生产环境托管页面
  market.js        行情缓存、日线 → 周/月/年线聚合、分时、分钟 K
  minutes.js       分钟 K：tushare 历史分钟按需拉取，缓存到本地库
  symbols.js       标的池 + 检索（代码 / 名称 / 拼音首字母 / 全拼）
  adapters/        数据源适配器（换数据商只动这里）
web/src/           渲染层 + 控制层（Vite + React）
  RenderPage.jsx   /render  直播画面 966×320（vMix 浏览器源）
  ControlPage.jsx  /        导播台（行情软件式操作，画面实时同步到 /render）
  KChart.jsx       KLineChart 封装，两端共用
  view.js          视图（显示根数 + 最右一根时间）、周期顺序
  indicators.js    可选的主图 / 副图指标
prototype/         最早的单页原型，仅供参考
```

## 运行

```bash
npm install
cp .env.example .env      # 按需修改 DATA_SOURCE / TUSHARE_TOKEN

# 开发：后端 8787 + vite 5173（带热更新）
npm run dev               # 打开 http://localhost:5173

# 直播：打包后单进程运行
npm run build
npm start                 # http://<直播机内网IP>:8787
```

- vMix：Add Input → Web Browser，URL 填 `http://127.0.0.1:8787/render`，尺寸与导播台「设置」里的画面尺寸一致（默认 966×320），背景透明。
- 导播机：浏览器打开 `http://<直播机内网IP>:8787`。Windows 防火墙需放行 8787 端口。

## 导播台操作

| 按键 | 作用 |
| --- | --- |
| ↑ / ↓（或滚轮） | 放大 / 缩小时间范围（40–1000 根） |
| ← / →（或拖拽） | 左右移动 1 根，按住 Shift 每次 10 根 |
| Home / End | 跳到最早 / 回到最新（跟随最新时会自动接上新 K 线） |
| Enter | 更小周期：年K → 月K → 周K → 日K → 分时（在分钟 K 上时直接进分时） |
| Backspace | 更大周期：分时 → 日K → 周K → 月K → 年K（在分钟 K 上时直接回日K）；5 / 15 / 30 / 60 分钟 K 点周期按钮进入 |
| PageUp / PageDown | 自选里的上一个 / 下一个（当前标的需在自选里，首尾循环） |
| Insert / Delete | 当前标的加入 / 移出自选 |
| 直接敲字母 / 数字 | 检索标的，如 `000001`、`SZZS`、`shangzheng`；中文名需先点检索框再输入 |

**画线**：K 线页左侧工具栏（线段 / 射线 / 直线 / 水平线 / 价格线 / 平行线 / 通道线 / 黄金分割 / 文字标注），选工具后在图上依次点击端点。拖动端点可修改；点中画线后按 Delete 删除；Esc 取消绘制；「清除」删除当前标的的全部画线。画线按「时间 + 价格」保存在服务端，按标的区分、各周期共用，直播画面同步显示（不可编辑）。

**自选**：顶栏「☆ 加自选」或 Insert 加入，右侧列表点击切换、悬停点 × 移出。股票、指数、板块都可以加，保存在服务端。

**隐藏个股**（直播合规）：
- 顶栏「隐藏个股」开关，默认开启，只对个股生效，指数和同花顺板块/概念照常显示。
- 开启时直播画面上个股名称中间打码，代码不显示：贵州茅台 → 贵＊＊台，五粮液 → 五＊液（保留首尾字）。真实名称和代码不进页面源码。
- 导播台顶栏会提示直播画面实际显示的内容。注意价格、均线数值仍会显示。

主图（MA / EMA / BOLL / SAR）和副图（成交量 / 成交额 / MACD / KDJ / RSI）在工具栏切换。同花顺板块没有成交额数据，副图为空。

**宏观数据**（需要 `DATA_SOURCE=local`）：二级导航按「利率 / 增长 / 物价 / 货币 / 两融」分组，← / → 切换图表，直播画面同步。

| 分组 | 图表 | 展现 |
| --- | --- | --- |
| 利率 | Shibor | 隔夜 / 1周 / 1月 / 3月 / 1年 多线，指标卡显示较前日 bp 变化 |
| | LPR | 1年期、5年期阶梯线，指标卡显示最近一次调整 |
| | 美债曲线 | 期限结构：最新 / 1个月前 / 1年前 三条曲线，看形态与倒挂 |
| | 美债走势 | 2年、10年收益率 + 10Y−2Y 利差柱 |
| 增长 | GDP | 单季 GDP 柱（由累计值推算）+ 当季同比线 |
| | PMI | 制造业 PMI 柱（≥50 红 / <50 绿）+ 非制造业、综合线 + 50 荣枯线 |
| 物价 | CPI · PPI | 两条同比线 + 0 轴 |
| 货币 | 货币供应量 | M1、M2 同比线 + M1−M2 剪刀差柱 |
| | 社融 | 当月增量柱 + 存量同比线 |
| 两融 | 融资融券 | 沪深北合计两融余额面积 + 融资买入额柱 |

数据在 `npm run sync` 末尾全量刷新，默认拉全部历史（`MACRO_YEARS=all`，也可填年数）。图表加载全部历史，默认显示最近一段（Shibor / 两融近一年、美债近两年、月度指标 3–5 年、GDP 近 5 年）；在导播台缩放或拖动下方时间轴可看更早的数据，直播画面同步。新增图表：`shared/macro.js` 加数据集和视图，`web/src/macro/charts.js` 加对应的绘图函数。

**页面与直播画面**：导播台顶部导航（K 线图 / 板块排名 / …）即直播画面内容，切页面 = 切直播画面，多台导播机同步。检索框在顶部，任何页面选中标的都会进入 K 线页。以后新增页面（如宏观数据）：`web/src/ControlPage.jsx` 的 `PAGES`、`server/index.js` 的 `SCENES` 各加一项，再加对应的导播台组件和直播画面组件。

**板块排名**（需要 `DATA_SOURCE=local`）：
- 申万一级 / 同花顺概念两个列表；列：涨幅、5 日、10 日、20 日涨幅、年初至今、涨停数、主力净额（亿）。
- 切列表、点表头排序（再点切换升降序）、改「直播显示前 N 名」，直播画面实时跟着变。
- ↑↓ 选择，Enter 或双击打开该板块 K 线，直播画面同步切到 K 线。
- 数据口径：涨停数 = 成分股中当日涨停的个数（`limit_list_d`，不含 ST）；主力净额：同花顺概念用官方板块资金流 `moneyflow_cnt_ths`，申万一级按成分股个股资金流（大单 + 特大单净买入）汇总。直播画面的区间、周期、指标与导播台完全一致，指标数值显示的是画面最右一根。页头始终显示**当日**最新价和涨跌（周K / 月K 下也是）。

右上角「⚙ 设置」：
- 指标参数：MA / EMA 可增减周期（最多 6 条），RSI 最多 3 条；BOLL、SAR、MACD、KDJ 改参数。输入不合法时会提示并禁止保存。
- 直播画面尺寸：默认 966×320，可自定义或选预设。画面变大时字号、线宽按比例放大。**改尺寸后，vMix 浏览器源的宽高要同步改。**
- 安全区外：设置里可以给直播画面左右两侧各留一段（直播时容易被裁掉），只铺底色，颜色和透明度可调（0 = 完全透明），K 线和文字都放在中间。
- 周期按钮：收起时只显示 分时 / 日K / 周K / 月K（加上当前选中的），点右侧箭头展开全部；直播画面上同样只显示这几个 + 当前周期。
- 设置保存在服务端（`.runtime/state.json`），所有画面实时生效，重启后保留；「恢复默认」可一键还原。

## 说明

- 页面资源（含 KLineChart）全部打包进 `dist`，运行时不依赖任何外网 CDN。
- 渲染页断线自动重连，断线期间保持最后一帧画面，不会黑屏。
- 行情拉取失败时保留上一份数据，导播台顶部显示红色错误提示。
- 周期：分时、5分、15分、30分、60分、日K、周K、月K、年K。周 / 月 / 年 K 由日线聚合（个股日线默认只同步 3 年，年K 只有几根；板块和指数是全部历史）。
- **分时和分钟 K 需要 tushare 历史分钟权限**（单独开通）：个股用 `stk_mins`，指数先试 `idx_mins`、不行再用 `stk_mins`。同花顺 / 申万板块 tushare 没有分钟数据，选中板块时自动隐藏这些周期（正在看分钟 K 时切到板块会退回日K）。
  - 按需拉取：第一次打开某标的的某个周期时拉最近 `MINUTE_MONTHS` 个月（默认 6，约 1～2 次请求），存进本地库；之后超过 `MINUTE_REFETCH_MS`（默认 10 分钟）才增量补拉当天。拉取失败时用库里已有的数据，不影响直播。
  - 盘后定时同步完成后，会顺带把自选 + 当前标的的 4 个分钟周期预拉一遍。
  - 个股分钟 K 前复权（与日线同一套复权因子），分时不复权；成交量统一换算成「手」。
  - 盘中能看到多新的分钟数据取决于 tushare 历史分钟接口何时更新；`MINUTE_MONTHS=0` 关闭分时和分钟 K。
- 大盘分时：白线 = 指数，黄线 = 领先指标（各股涨跌幅简单平均，不按市值加权），
  红绿柱 = 每分钟「上涨家数 − 下跌家数」比上一分钟的变化（同花顺原版用全市场委买委卖量，tushare 没有盘口数据，用涨跌家数代替）。
  - 上证指数 / 深证成指 / 创业板指 / 科创综指：用整个沪市 / 深市 / 创业板 / 科创板的股票算。
  - 成分股指数 `BREADTH_INDICES`（默认 上证50 / 沪深300 / 中证500 / 中证1000 / 科创50 / 北证50）：用各自的成分股算，
    成分股来自 tushare `index_weight`，每月刷新；拿不到时科创50 用整个科创板、北证50 用整个北交所近似，其他指数不显示。
  盘后定时同步时用全市场个股的 1 分钟线算出最近一个交易日的数据（`stk_mins`，能一次查多只时约 200 次请求，否则约 5000 次、十来分钟），
  每天算一次，分钟数据还没发布时留到下次同步；没算出来之前分时图只有白线。`BREADTH=0` 关闭。
  个股分时：白线 = 价格，浅黄线 = 均价。
- 导播最后的选择保存在 `.runtime/state.json`，服务重启后自动恢复。
- 只有 `role=control` 的连接能修改状态。默认不鉴权，只能在内网用；部署到服务器前见下面「鉴权」。

## 鉴权（部署到服务器）

登录由围炉工作台（[WeiLuApp](https://github.com/juryory/WeiLuApp)）负责，Kline 后端只校验工作台签发的 JWT。实现见 `server/auth.js`。

```bash
npm run token -- secret      # 生成 AUTH_SECRET / RENDER_KEY，填进 .env（AUTH_SECRET 与工作台一致）
```

| 环境变量 | 说明 |
| --- | --- |
| `AUTH_SECRET` | JWT（HS256）签名密钥，与工作台一致。**不填 = 不鉴权**（内网模式） |
| `RENDER_KEY` | 直播画面只读 key，vMix 地址填 `https://<域名>/render?key=<RENDER_KEY>` |
| `AUTH_COOKIE` | 登录 Cookie 名，默认 `weilu_token`，与工作台一致 |
| `ALLOWED_ORIGINS` | 允许的页面来源，逗号分隔；不填 = 只允许与服务同域名 |

- 角色：`admin`（全部操作 + 触发数据同步）、`control`（导播台全部操作）、`render`（只读 key，只能接收画面数据）。
- JWT payload：`{ sub, name, role: 'admin' | 'control', exp }`，`exp` 必填。凭证按顺序取 `Authorization: Bearer`、Cookie、`?token=`（仅调试）。
- 导播台、预览、`/api/*` 需要登录；直播画面和 `/api/macro` 可用 `RENDER_KEY`；`POST /api/sync` 需要 `admin`。
- 直播画面地址 `/render?key=<RENDER_KEY>`：登录后打开 `/render` 会自动把 key 补进地址栏，导播台底部也会显示完整地址，可直接复制到 vMix。
- WebSocket 和改数据的请求校验 Origin，防止别的网站借导播员浏览器里的登录态发指令。
- 未登录 / 过期时 WebSocket 以 4401 关闭，导播台顶部提示重新登录。连接中 token 到期以 4001 断开，客户端立即重连：工作台页面开着时会定时续期 Cookie，重连即用新 token 接上，导播无感。
- 推荐部署：工作台 `work.example.com`，Kline `kline.example.com`（宝塔反向代理到 8787，开启 HTTPS 和 WebSocket），工作台把 Cookie 写在 `.example.com` 上，两边共享登录态。
- 调试：`npm run token`（导播，8 小时）或 `npm run token -- admin 24`，打开输出里的 `/api/login?token=…` 链接即可登录（写入 Cookie 后跳到导播台）。

## Docker 部署

一个服务一个容器：镜像里是后端 + 打包好的导播台 / 直播画面，数据在数据卷 `/data`，配置全走环境变量（镜像里没有 `.env` 和密钥）。

```bash
docker compose build
cp .env.docker.example .env.docker                  # 填 TUSHARE_TOKEN / AUTH_SECRET / RENDER_KEY / ALLOWED_ORIGINS
docker run --rm kline:latest npm run token -- secret  # 生成 AUTH_SECRET / RENDER_KEY
docker compose up -d
docker compose exec kline npm run sync              # 首次建库（约半小时）
```

- **时区**：镜像固定 `TZ=Asia/Shanghai`，不要改。交易日 → 时间戳、周K / 月K 聚合、同步判断「今天」都按本地时区，UTC 下周K 会错位。
- **数据卷** `kline-data:/data`：`market.db`（行情库，含 `-wal` / `-shm`）和 `runtime/state.json`（导播状态：设置、自选、画线）。重建容器不丢。
  - 已有本地库可以直接拷进去，省掉首次同步：先停服务 `docker compose stop`，再 `docker compose cp data/market.db kline:/data/market.db`，然后 `docker compose start`。
  - 改用宿主机目录（如 `./kline-data:/data`）时，容器以 `node` 用户（uid 1000）运行，需要先 `chown -R 1000:1000 ./kline-data`。
- **定时同步**：`.env.docker` 里 `SYNC_WINDOW=15:30-21:00`、`SYNC_EVERY=15`、`SYNC_DAYS=1-5`，北京时间周一至周五 15:30 开始，每 15 分钟后台同步一次，包含 21:00，共 23 个触发时刻；上一轮未结束时跳过，不并发执行。不需要宿主机计划任务。升级已有部署时也要更新 `.env.docker` 的这两项，并运行 `docker compose up -d --build` 重新创建容器。同步记录在导播台「设置 → 数据同步」，完整日志在数据卷的 `sync-logs/`。也可以手动 `docker compose exec kline npm run sync`。
- **健康检查**：`GET /healthz`（不需要登录），镜像已配 `HEALTHCHECK`。
- **只能跑一个实例**：导播状态和行情缓存在进程内存里，不要开多个副本。
- **端口**只绑定 `127.0.0.1:8787`，由宝塔 Nginx 反向代理对外。宝塔给 `kline.example.com` 开 HTTPS，反向代理到 `http://127.0.0.1:8787`，配置里要有 WebSocket 和转发头：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8787;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 1h;   # WebSocket 长连接
  }
  ```

- 调试 token：`docker compose exec kline npm run token -- admin 24`。

## 接入 tushare（收盘数据）

直播时只读本机的 SQLite 库，不访问公网；tushare 只在盘后同步时调用。

```bash
# .env
DATA_SOURCE=local
TUSHARE_TOKEN=你的token
SYNC_INDICES=000922.CSI,399673.SZ   # 可选：内置常用指数之外还要同步的指数

npm run sync   # 首次：个股近 3 年 + 板块和指数全部历史，约半小时；之后每天只补新交易日，几十秒
npm start
```

- 范围：个股 `SYNC_YEARS`（默认 3 年）；同花顺板块、申万一级、指数 `BOARD_YEARS`（默认 `all` 全部历史，也可填年数）。板块类接口会先探测最早有数据的日期，历史上无数据的交易日只请求一次；指数按代码往前补历史，每个代码只补一次。
- 个股：`daily` + `adj_factor` 按交易日拉全市场，画面为**前复权**。
- 指数：`index_daily` 按代码拉，范围 = `server/symbols.js` 内置指数 + `SYNC_INDICES`。
- 申万一级行业：`index_classify` 取列表，`sw_daily` 按交易日拉日线（板块排名用，也可以检索看 K 线）。
- 板块排名数据：涨停 `limit_list_d`、个股资金流 `moneyflow`、同花顺概念资金流 `moneyflow_cnt_ths` 只同步最近 20 个交易日；成分股 `index_member_all` / `ths_member` 每 7 天刷新一次（`SYNC_MEMBERS=1` 强制刷新）。这几个接口失败只告警，不影响行情同步。
- 同花顺板块（需 6000 积分）：`ths_index` 取板块列表，`ths_daily` 取日线。默认同步概念和行业，类型由 `SYNC_THS_TYPES` 控制（加上 `R` 就有地域板块）。同步时先探测能否按交易日批量拉，能则每天 1 次调用，否则按板块代码逐个增量拉（每天约几百次调用，一两分钟）。检索里标注「同花顺概念 / 同花顺行业」，如 `pcb` → PCB概念、`qs` → 券商概念。同花顺板块没有成交额数据，成交量正常显示。
- 检索用的股票列表来自 `stock_basic`，同步后**重启服务**才会载入新上市的股票。
- 可重复运行、可中断续传；当天数据未发布时会跳过，下次自动补上。
- 当天复权因子若还没发布，沿用前一天的因子，下次同步后自动修正。
- 同步和直播可以同时进行（SQLite WAL 模式）；后台同步完成后自动刷新画面和排名，命令行跑 `npm run sync` 的话服务 5 分钟内会读到新数据。
- 也可以通过接口触发（不用登录直播机）：
  - `POST /api/sync`（admin）：后台跑一次 `npm run sync`，完成后自动重载标的池并刷新画面；正在同步时再调用会返回 `ok: false`
  - `GET /api/sync`：同步进度、定时设置、最近 60 次同步记录（`history`）、今天各数据第一次到达的时间（`arrivals`）
  - `POST /api/refresh`：只重新读取本地库并刷新画面

  ```bash
  curl -X POST http://<直播机内网IP>:8787/api/sync
  ```

### 收盘后定时同步

后端内置定时同步（需要 `TUSHARE_TOKEN`），按服务器时区计时：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SYNC_WINDOW` | `15:30-21:00` | 时间窗口，包含结束时刻 |
| `SYNC_EVERY` | `15` | 窗口内每隔多少分钟同步一次（15:30、15:45 … 21:00）；`0` = 关闭 |
| `SYNC_AT` | 空 | 另外再加的固定时刻，可多个，逗号分隔（如 `08:30`） |
| `SYNC_DAYS` | `1-5` | 星期，`0`/`7` = 周日，也可写 `1,3,5` |
| `SYNC_LOG_KEEP` | `500` | 保留最近多少份同步日志 |

每次同步都会留记录，用来观察同花顺概念等数据每天几点发布：

- 导播台「设置 → 数据同步」：每次同步后各数据（个股、同花顺概念、概念资金流、申万、涨停、个股资金流）的最新日期，标出本次新到的数据和仍落后于个股的数据，以及今天每种数据第一次同步到的时间。
- `data/sync-history.jsonl`：每次一行 JSON（起止时间、结果、同步前后各数据最新日期）。
- `data/sync-logs/*.log`：每次同步的完整输出。
- 服务日志（`docker compose logs kline`）每次一行摘要，如 `[sync] 18:30 定时同步结束 exit=0 用时 41s｜新到：同花顺概念 20261014｜仍落后于个股：概念资金流 20261013`。

#### 或者用 Windows 计划任务

用管理员 PowerShell 执行一次，工作日 17:30 自动同步，日志写到 `data\sync.log`：

```powershell
schtasks /Create /TN "KlineSync" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 17:30 `
  /TR "cmd /c cd /d <项目路径> && npm run sync >> data\sync.log 2>&1"
```

## 新增数据源

ETF 日线默认参与 `npm run sync` 和定时同步；不配置 `SYNC_ETF` 时也会启用，显式设置 `SYNC_ETF=0` 可关闭。如果服务器沿用了旧配置中的 `SYNC_ETF=0`，请改为 `1` 并重新创建容器。首次同步会补最近三年历史，后续断点续传并增量更新，使用 `ETF_YEARS` 调整范围。也可单独运行 `npm run sync:etf`；Docker 部署使用 `docker compose exec kline npm run sync:etf`（先重新构建并启动更新后的镜像）。需要 `fund_basic` / `fund_adj` 的 2000 积分权限以及 `fund_daily` 的 5000 积分权限，不调用 8000 积分的 ETF 基础信息接口，也不请求独立收费的 ETF 分钟数据。

标的从场内基金目录中按名称含 ETF、非联接基金识别，可能遗漏命名不符合此规则的标的；仅在实际取得日线后加入搜索列表，包含范围内有历史数据的已退市 ETF。日线保持原始价格、成交量（手）和成交额（千元），显示时使用基金复权因子计算前复权并保留三位小数。同步按交易日记录进度，可中断续传；最近两个交易日重查，缺复权因子的日期保持待补状态。北京时间 18 点前不将当天作为盘后更新目标。

1. 在 `server/adapters/` 新建文件，导出 `label`、`getDaily(symbol)`、`getIntraday(symbol)`，可选 `listSymbols()`（接口说明见 `server/adapters/index.js`）
2. 在 `server/adapters/index.js` 注册
3. `.env` 中设置 `DATA_SOURCE=<名字>`


## Tushare / iFinD 数据源切换

按步骤部署见 [iFinD 第一版上线清单](docs/ifind-rollout.md)。

导播台 → 设置 → 行情数据源，管理员可切换 **Tushare 本地库** / **iFinD**。
切换立即刷新图表、标的池和周期权限，不触发公网取数；选择保存在行情库同目录的
`data-source.json`，重启后仍有效（优先于 `.env` 的 `DATA_SOURCE`）。同步运行期间禁止切换。
`GET /api/data-source` 查询状态；管理员 `POST /api/data-source`，JSON 为 `{"source":"ifind"}` 或 `{"source":"local"}`。

- iFinD：现有境内股票、ETF、同花顺行业/概念、申万板块和指数日线；指数、板块、ETF 拉 1 分钟分时，个股不拉分时。
- 指数范围：项目内置指数、已有无 category 的指数，以及微盘股 `883418.TI`。另外同步少量指数日线供昨收和涨跌幅使用。
- 非个股显示“分时”及由 1 分钟本地聚合的 5/15/30/60 分钟 K，保留 ETF 价格精度。
- iFinD 写入独立数据库：默认 `DB_PATH` 同目录下的 `ifind.db`，可用 `IFIND_DB_PATH` 指定。
  Docker 默认 `/data/ifind.db`，与旧库 `/data/market.db` 共用持久数据卷；两个路径不可相同。
  旧库以 SQLite `mode=ro` 挂载，不能从 iFinD 连接写入；此前旧库中的 iFinD 独立表会一次性复制到新库，原表保留。
- 按日期/时间戳合并：同一条优先 iFinD，缺口使用本地已有 Tushare 数据；不会因缺历史自动请求 Tushare。
- **iFinD 模式统一不复权**，包括补入的 Tushare 原始历史，避免跨供应商复权错配。
  Tushare 模式保持原来的股票/ETF 前复权。图表来源标签明确说明口径，API `bars[].dataSource` 标记每条实际来源。
- 排名价格使用同样的合并日线；资金流、涨停、成分股、宏观和领先指标仍读取已有 Tushare 本地数据，本轮 iFinD 同步不更新它们。
- 港股指数、美股指数和期货尚未启用。候选清单示例在 `config/ifind-universe.example.json`，
  可通过 `IFIND_UNIVERSE_FILE` 保留清单，`enabled=false` 不导入。当前只接受启用境内 CN 标的。
  海外/期货需要另行验证代码、历史权限、夏令时、夜盘归属及前端交易时段；不能套用 A 股分钟规则。

### 服务器配置与运行

在服务器 `.env`（Docker 使用 `.env.docker`）填写 `IFIND_REFRESH_TOKEN`。这是 iFinD 官方账号详情里的
Refresh Token，不是先前 FFD 的 API Key。也支持临时配置 `IFIND_ACCESS_TOKEN`；同时填写时优先使用 Refresh Token。
凭证只用于 `https://quantapi.51ifind.com/api/v1/` 的请求头，不落入前端、源码或日志。
账号续期/升级后需重新获取对应 Refresh Token。没有凭证也可以切换查看已有历史，自动同步不会启用。

```bash
# 查看日常计划（不调用数据接口）
npm run sync:ifind -- --dry-run
# 按当前选择的数据源同步
npm run sync
# 明确同步某个来源，不改变界面选择
npm run sync:ifind
npm run sync:tushare
# 单独补历史；不会改变默认日常模式
# 分钟历史补全：看进度（不耗额度）/ 跑一轮 / 补满到官方停止线（可 Ctrl+C）
npm run sync:ifind -- --backfill --dry-run
npm run sync:ifind -- --backfill
npm run sync:ifind -- --backfill --drain
# 当天已结束分钟的增量（不开启定时也可手动使用）
npm run sync:ifind -- --intraday
# Docker 示例
# docker compose exec kline npm run sync:ifind -- --dry-run
# docker compose exec kline npm run sync:ifind
```

自动盘后任务为北京时间周一至周五 **15:30—21:00，每 15 分钟一次**（Docker 已设置 `TZ=Asia/Shanghai`）。
日常模式只同步已收盘日期，`IFIND_CLOSE_CUTOFF`（默认 15:30）前截止前一日；宏观数据每天只拉一次。默认滚动最近 7 个自然日，跳过已经完成的标的/日期。
`--backfill` 补最近 `IFIND_BACKFILL_MONTHS`（默认 6）个月的分钟线和同期 iFinD 日线，按批次：核心指数 → 同花顺概念 →
同花顺行业 / 申万一级 → 成交额前 300 的 ETF；核心指数还先补 `IFIND_HISTORY_YEARS` 年 iFinD 日线，深证成指、创业板指补全历史（成交额口径前后一致）；额度、定时和核对规则见 `docs/ifind-rollout.md` 第 4 节。
没有分钟数据的指数（700xxx、884xxx 三级行业等）自动记下，补历史和盘后同步都跳过。申万一级按 `801xxx.SL` 请求。
**1.5 亿额度不等于拥有全部历史年限。** 更早的旧库行情仍能读取；旧库也没有的部分，需先确认账号历史权限再提高 `IFIND_HISTORY_YEARS`。
各类型优先处理最近日期；日线先同步供昨收使用，然后处理分钟。任务每轮默认最多 2000 次请求或 600 秒，
先到上限后输出 `deferred=true`，保留断点供下次继续；`--dry-run` 的 `estimatedCells` 只计算本轮计划，并非整个半年总额。
可以用 `IFIND_MINUTE_START_DATE` / `IFIND_DAILY_START_DATE` 独立指定起点；
`IFIND_START_DATE=YYYY-MM-DD` / `IFIND_END_DATE=YYYY-MM-DD` 指定两类共同区间。
测试时设置 `IFIND_SYMBOLS=000001.SH,510300.SH` 限定标的；正式全量运行前清空此项及临时 END_DATE。
恢复日常同步时清空临时起止日期，避免每次盘后都遍历历史任务。

日线每批至多 100 个代码/一天；分钟每批至多 20 个标的/一天，按六字段估算低于单请求 5 万单元格。
每个标的/日期独立记断点，成功项跳过，空值和部分数据保持待补；超过 7 天的空缺每天重试一次。
分钟必须覆盖 09:31—11:30、13:01—15:00 全部 240 个分钟结束时刻才标记完整，不只检查行数。
目前只排除周末，尚无独立节假日/上市日期日历；节假日、上市前和停牌的空响应会保留为待补。
休市、停牌、不支持的代码也可能返回空，日志会显示待补，不能把“请求成功”当作“数据全量完成”。
接口失败停止该类任务，另一类继续，避免权限错误导致连续消耗；日志中的错误码可在官方错误查询核对。
同步锁文件 `ifind-sync.lock` 防止多进程重复拉取；异常退出留下锁时，确认没有同步进程后再移除。

默认 `IFIND_QUOTA_PROFILE=trial`：日线、高频共用 **1.5 亿/周**本地账本，历史任务最多 **1 亿/周**，
保留 **2000 万**不自动使用，正常增量有至少 **3000 万**空间。北京时间周一零点开始新一周。
每次调用原子预留，再按响应 `dataVol` 校正；网络失败保留预留量，避免漏记。正式账号总额可调整 `IFIND_WEEKLY_BUDGET`。
账本只覆盖本项目经此同步器发出的请求，**不包含其他终端使用量，也不能自动读取官方剩余额度**。
先前消耗的额度应从本周可用预算中扣除；同一账号不要在多台服务器独立计账后各自按 1.5 亿运行。
设置面板会显示周账本、各类最新日期及当日覆盖数；最新日期并不表示全部历史完整。
旧免费账号可显式使用 `IFIND_QUOTA_PROFILE=free`，恢复日线 `IFIND_DAILY_BUDGET=900000`、
分钟 `IFIND_MINUTE_BUDGET=1400000` 的独立月预算。

盘中实时数据按需拉取，无需开关：只有正在查看的标的（分时、日K、分钟 K）和排行才请求 iFinD，不看的不更新，
详见 `docs/ifind-rollout.md` 第 4 节。拉到的分钟线写进库里，盘后同步看到完整的一天直接跳过，不重复消耗。
这属于分钟级 HTTP 请求，**不是逐笔实时推送**。日常同步和手动历史补齐共用锁文件，建议历史任务在收盘同步窗口外运行。

### 代码与单位核对

同步复用本地 `symbols` 标的池，不会自动发现新上市股票/ETF/新板块；可定期明确执行 Tushare 同步刷新目录。
默认沿用本地代码。同花顺板块、申万等供应商专有代码若不一致，必须核对并配置映射，
不要只按名称模糊匹配。单位默认按 iFinD 股/元解释，再转为本项目日线手/千元、分钟股/元；
上线前请用少量样本对照 Super Command 的代码及单位，特殊代码通过 `IFIND_CODE_MAP_FILE` 配置：

```json
{
  "某本地代码": { "code": "官方实际代码", "volumeUnit": "share", "amountUnit": "yuan" }
}
```

`volumeUnit` 可为 `share`（股）或 `lot`（手），`amountUnit` 为 `yuan`（元）或 `thousand`（千元）。
凭证、标的权限和单位尚需在目标服务器上做少量真实取数验证；离线测试不会使用账号额度。
参考：[官方 HTTP 部署说明](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/deploy.html)、
[接口手册](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)。
