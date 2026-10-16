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
| Enter | 更小周期：年K → 月K → 周K → 日K → 60分 → 30分 → 15分 → 5分 → 分时 |
| Backspace | 更大周期：分时 → 5分 → 15分 → 30分 → 60分 → 日K → 周K → 月K → 年K |
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
- **定时同步**：`.env.docker` 里 `SYNC_WINDOW=15:30-23:30`、`SYNC_EVERY=30`、`SYNC_DAYS=1-5`，收盘后每 30 分钟后台自动同步一次，不需要宿主机计划任务。同步记录在导播台「设置 → 数据同步」，完整日志在数据卷的 `sync-logs/`。也可以手动 `docker compose exec kline npm run sync`。
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
| `SYNC_WINDOW` | `15:30-23:30` | 时间窗口 |
| `SYNC_EVERY` | `30` | 窗口内每隔多少分钟同步一次（15:30、16:00 …）；`0` = 关闭 |
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

1. 在 `server/adapters/` 新建文件，导出 `label`、`getDaily(symbol)`、`getIntraday(symbol)`，可选 `listSymbols()`（接口说明见 `server/adapters/index.js`）
2. 在 `server/adapters/index.js` 注册
3. `.env` 中设置 `DATA_SOURCE=<名字>`
