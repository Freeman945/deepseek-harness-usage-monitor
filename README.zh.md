# DeepSeek Harness 用量监控（Usage Monitor）

**在 DeepSeek Harness 内实时查看余额、Token 用量、缓存命中率，并检测异常消耗。**

这是一个 DeepSeek Harness（DSH）插件，在 Harness 侧边栏中加入 **用量监控** 面板：真实的登录账户余额、
服务商上报的 Token 用量、缓存命中率、消耗速率（burn rate）、成本归因、缓存诊断、异常检测与余额预测。
所有数据都在本地基于 Harness 的官方数据计算得出。

[![CI](https://github.com/Freeman945/deepseek-harness-usage-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Freeman945/deepseek-harness-usage-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

[English](README.md) | 简体中文

---

## 截图

![用量监控面板——深色主题、中文界面](docs/screenshots/dashboard.png)

![为什么用量偏高：工作负载证据与效率证据，以及只保留证据的异常时间线](docs/screenshots/why-usage-high.png)

两张图均为安装了本插件后的本地 DeepSeek Harness 真实运行截图（深色主题、中文界面；插件同时支持英文与
中文）。钱包金额已打码，未使用任何模拟数据。第二张图由同一仪表盘的两个区域拼接：工作负载/效率评估，以及
只保留证据的异常时间线与预测。

---

## 功能

| 功能 | 说明 |
|---|---|
| **真实余额监控** | 通过 Harness 官方账户服务读取当前登录的 DeepSeek 账户钱包；充值余额与赠送余额分开显示，不做任何汇率换算，也不编造余额。 |
| **Token 用量** | 从持久化 Session 日志读取服务商上报的输入、输出、缓存命中与缓存写入 Token；会话运行期间实时增量更新。 |
| **消耗速率** | 最近 5 分钟 / 30 分钟 / 1 小时的估算每小时花费，与基于"实际有请求的 5 分钟分桶"计算出的**活跃负载基线中位数**对比；23 小时算术平均只作为参考显示。 |
| **成本窗口** | 今天、最近 1 小时、最近 24 小时、最近 7 天、本月；每个窗口同时给出 `Est.`（Token × 价目表估算）与（在有覆盖时）`Observed`（真实钱包减少额）。 |
| **缓存监控** | 与 Harness 自身一致的缓存命中率公式、带死区的相对当前小时之前 24 小时窗口变化、绝对健康状态、估算的**缓存避免的额外输入费用**（不是退款），以及分桶趋势。 |
| **Agent / 会话 / 模型用量** | 按会话、按任务（对话轮次）、按 Agent 预设 / 子代理、按未命中缓存 Token 成本排名，另有按模型的明细。 |
| **证据门控的异常检测** | 正常 / 提示（Notice）/ 警告 / 严重：消耗高本身只算提示，警告需要真实的效率证据，严重必须同时满足"高消耗 + 佐证"。包含活跃负载基线、基线预热、缓存死区，以及带"恢复正常"记录的 24 小时时间线。 |
| **告警** | 只有警告 / 严重条件会成为告警并带有起始时间；提示只作信息展示。余额阈值告警可配置。 |
| **趋势** | 1 小时 / 6 小时 / 24 小时 / 7 天趋势图，自动选择分桶粒度。 |
| **预测** | 估算每日费用，以及按当前消耗速率推算的余额可用时间，并注明估算依据。 |
| **浅色 / 深色、英文 / 中文** | 使用 Harness 主题变量与当前 Harness 语言设置。 |
| **纯本地** | 无遥测、不上传、不接第三方服务、无运行时依赖。 |

> Harness 本身已经在聊天界面显示当前轮次的用量、在"设置 → 账户"显示余额。本插件把同样的官方数据
> 变成持久化面板，增加历史窗口与归因，并解释*为什么*花费发生了变化。

## 环境要求

| 要求 | 说明 |
|---|---|
| DeepSeek Harness | **0.2.1-rc.2**（桌面版或 Web 配置） |
| 插件版本 | **0.1.1** |
| Node.js | **≥ 20**（DSH 自带 Node；仅开发时需要本机 Node） |
| DeepSeek 账户 | 在 **设置 → 账户** 中登录后才能看到真实余额；Token 与估算成本面板无需登录也可用。 |
| API Key | **不需要。** 插件不会索取、读取或保存任何 API Key。 |
| 环境变量 | **没有。** 不需要创建 `.env`。 |
| 构建 / 依赖 | **都不需要。** 纯 Node.js ESM 源码，零运行时依赖。 |

## 安装

### 分步安装

1. **克隆仓库**到固定位置。插件按文件夹路径安装，安装后不要移动或删除该文件夹。

   ```bash
   git clone https://github.com/Freeman945/deepseek-harness-usage-monitor.git
   ```

2. **打开 Harness Web 界面**，进入 **侧边栏 → 插件（Plugins）**。

3. **添加插件：** 点击 **添加插件（Add plugin）**，粘贴克隆文件夹的**绝对路径**并确认。

   ```text
   Windows:  C:\Users\<you>\deepseek-harness-usage-monitor
   macOS:    /Users/<you>/deepseek-harness-usage-monitor
   Linux:    /home/<you>/deepseek-harness-usage-monitor
   ```

4. 点击 **安装（Install）**，然后点击 **立即启用（Enable now）**（也可在插件列表中启用 *Usage Monitor*）。

5. 在侧边栏面板列表中点击 **用量（Usage）**，主区域会打开 **用量监控（Usage Monitor）** 页面。
   如果暂时看不到入口，刷新一次 Harness 窗口。

无需 API Key，也无需任何配置。如果已登录 DeepSeek 账户，余额会在下一次轮询时出现；Token 历史会立即从既有
Session 日志读取。

### 备选方式：让 Harness Agent 安装

让 Harness Agent 使用 `plugin_manager` 工具安装该 bundle —— `action: install_bundle`，
`target: <文件夹绝对路径>`。等待"已启用"确认后，如果面板没有出现，刷新一次窗口。

### 备选方式：命令行

```bash
dsh plugin --profile <配置名> add link:<文件夹绝对路径>
```

然后在插件页面启用该 bundle，或把 `deepseek-harness-usage-monitor` 加入
`$DSH_HOME/profiles/<配置名>/package.json` 的 `dsh.profile.bundles` 并重启 Harness。

### 卸载 / 重置

在插件页面停用或移除该 bundle。运行数据保存在包目录之外的 `$DSH_HOME/usage-monitor/`
（默认 `~/.dsh/usage-monitor/`）；删除该文件夹即可重置历史、设置与已观测花费的覆盖范围。

## 使用

在左侧边栏面板栏中点击 **用量（Usage）**，主区域会打开 **用量监控（Usage Monitor）** 页面。
页面可见时每 5 秒刷新一次；钱包轮询不会快于 `balanceRefreshSeconds`（默认 45 秒，可配置 20–600）。

| 数字 | 含义 | 如实说明 |
|---|---|---|
| **余额（Balance）** | 来自 DeepSeek 账户的真实钱包金额，充值余额与赠送余额分开展示。 | 需要登录账户；CNY 与 USD 之间从不换算。 |
| **消耗速率（Burn rate）** | 最近 5 分钟 / 30 分钟 / 1 小时的估算每小时花费，以及相对**活跃负载基线中位数**的倍数（同时显示相对 23 小时平均的倍数作为参考）。 | 属于估算：Token × 官方价目表。消耗高本身不代表异常。 |
| **缓存命中率** | 最近 1 小时的 `cacheRead / (cacheRead + input + cacheWrite)`，以及带死区的相对当前小时之前 24 小时窗口变化与绝对健康状态。 | 与 Harness 自身用量显示使用同一公式；小于 5 个百分点的变化视为噪声。 |
| **缓存避免费用** | 缓存命中避免的额外输入费用估算（`Est.`）：命中缓存的 Token 按缓存命中价而不是未命中价计算。 | 不是退款、不是平台返还，也不是可消费的抵扣。 |
| **`Est.` 金额** | Token × 官方 DeepSeek 价目表，区分高峰 / 空闲时段。 | 是估算，**不是**服务商账单。 |
| **`Observed` 金额** | 真实金额：两次余额轮询之间钱包的减少额，在窗口内累加。 | 从开始监控时起算，没有历史回填；窗口未完全覆盖时会标记为不完整。 |
| **消耗排行（Top consumers）** | 按会话、任务（轮次）、Agent 预设、未缓存 Token 成本排名。 | 归因来自 Session 元数据，而非逐请求的 Agent 名称。 |
| **"为什么用量偏高？"** | 把**负载证据**（请求速率、上下文大小）与**效率证据**（缓存下降、未命中突增、单会话集中）分开，并给出主要驱动因素判断。 | 是证据，不是已被证明的服务商侧根因。 |
| **预测（Forecast）** | 估算每日费用，以及按最近消耗速率推算的余额可用时间。 | 是基于近期用量的推演，不是保证。 |

用**范围切换**（1 小时 / 6 小时 / 24 小时 / 7 天）改变趋势图区间；点击**齿轮**打开设置。
**刷新**会立即强制读取一次钱包并重新扫描 Session，无需等待定时器。**时间线**按时间倒序列出异常，
包括"用量已恢复正常"的记录。

## 配置

日常使用**不需要环境变量、`.env` 文件或 API Key**。你通常需要调整的阈值与间隔都在面板的 **设置** 抽屉中，
会经过校验和范围限制，持久化在 `$DSH_HOME/usage-monitor/settings.json`，并优先于 bundle 默认值。
另有少数高级字段（包括 v0.1.1 新增的异常质量参数）由 Host 接受、但抽屉中暂无对应控件，需要通过 bundle 行
或设置 API 配置（见下）。v0.1.0 保存的 `settings.json` 可直接加载，新字段自动使用默认值。

### 设置抽屉中的项目

| 设置项 | 默认值 | 范围 / 说明 |
|---|---|---|
| `currency` | `auto` | `auto` 跟随登录钱包；`CNY` / `USD` 强制使用对应价目表。不做换算。 |
| `balanceRefreshSeconds` | `45` | 20–600。两次钱包读取之间的最小间隔。 |
| `warningBurnRatio` | `2` | 消耗速率 ≥ **活跃负载基线**的该倍数 → 警告（无佐证时为提示）。 |
| `criticalBurnRatio` | `4.5` | 消耗速率 ≥ 该倍数时，**只有在有佐证时**才算严重，否则为提示；若设置得低于警告值会被提升到警告值。 |
| `cacheWarningRate` | `0.5` | 绝对缓存命中率低于该值 → 警告级缓存健康（需持续 `cacheAlertMinutes`）。 |
| `cacheCriticalRate` | `0.3` | 绝对缓存命中率低于该值 → 严重级缓存健康；若设置得高于警告值会被降低。 |
| `cacheAlertMinutes` | `10` | 1–240。低缓存告警需要持续的分钟数。 |
| `requestRateWarningMultiplier` | `2` | 最近 15 分钟请求速率 ≥ 活跃请求速率基线的该倍数 → 负载提示。 |
| `costSpike10m` | `5` | 10 分钟内的展示货币花费超过该值视为成本尖峰。 |
| `balanceAlerts` | `[50, 20, 10]` | 展示货币阈值；触发最低的已越过阈值，最低阈值视为严重。 |
| `retentionDays` | `14` | 1–30。超过该天数的请求记录与钱包样本会被清理。 |

### 高级设置（bundle 行或设置 API）

以下字段使用同一套校验白名单，但暂未出现在抽屉中。可通过 bundle 行的 `config` 写入（在
`settings.json` 尚不存在时作为默认值；删除该文件可重新写入），或在已登录的 Harness 页面向
`/api/usage-monitor/settings` POST。

| 设置项 | 默认值 | 范围 / 说明 |
|---|---|---|
| `scanIntervalSeconds` | `60` | 15–600。完整 Session 重扫间隔（实时事件仍会增量更新）。 |
| `holidays` | `[]` | 中国法定节假日 `YYYY-MM-DD` 列表，用于切换到空闲时段计价。 |
| `pricingOverrides` | `{}` | 按模型或按档位的 `{cacheHit, cacheMiss, output}` 单价（每百万 Token，展示货币）。 |
| `exposeDiagnosticsFile` | `true` | 写入 `$DSH_HOME/usage-monitor/status.json`（不含提示词与凭据）用于支持排查；设为 `false` 可关闭。 |
| `minimumActiveRequests` | `1` | 1–1000。5 分钟分桶中有多少次请求才算"活跃负载"。 |
| `minActiveBuckets` | `6` | 2–288。基线达到 `ready` 所需的活跃分桶数。 |
| `baselineMinRequests` | `30` | 1–1,000,000。23 小时基线窗口内达到 `ready` 所需的请求数。 |
| `baselineMinCoverageHours` | `1` | 0.25–24。达到 `ready` 所需的已观测历史小时数。 |
| `cacheDeltaDeadband` | `0.05` | 0–0.5。小于该值（默认 5 个百分点）的缓存变化视为中性。 |
| `cacheDeltaNotice` | `0.15` | 0.02–0.95，且必须大于死区。超过该值的变化为警告级。 |
| `cacheHealthyRate` | `0.9` | 0–1；若低于 `cacheWarningRate` 会被提升到该值。绝对命中率视为健康的下限。 |
| `criticalRequiresSecondaryEvidence` | `true` | 设为 `false` 时"高消耗本身"也可判为严重（不推荐）。 |
| `uncachedBurstMultiplier` | `3` | 1.2–20。未命中输入 Token / 请求数相对活跃基线的倍数。 |
| `uncachedBurstMinTokens` | `10000` | 0–1,000,000,000。未命中突增的绝对 Token 下限。 |
| `sessionDominanceShare` | `0.7` | 0.3–1。单个会话占近期未命中 Token 的比例达到该值视为集中（仅作佐证）。 |
| `contextGrowthMultiplier` | `1.8` | 1.1–10。平均提示词大小相对活跃基线的倍数。 |

### Bundle 行默认值

该 bundle 插入一行 Host 插件（`cordis.patch.yml`）。其 `config` 只在你尚未保存页面设置时作为默认值；
之后以页面保存设置为准。

```yaml
- insert:
    - id: usage-monitor
      name: deepseek-harness-usage-monitor
      config:
        balanceRefreshSeconds: 45   # 钱包轮询下限（秒）
        retentionDays: 14           # 请求 / 钱包样本保留天数
```

> 如果机器上已有 `settings.json` 且需要配置节假日，请改用设置 API，或删除
> `$DSH_HOME/usage-monitor/settings.json` 后重新安装行配置。

## 异常检测原理

插件**不使用**机器学习、EWMA 或不透明评分。每个条件都是对保留样本的确定性规则，并带有稳定 ID，
以便时间线记住条件何时开始、何时恢复。基线是固定窗口上的透明算术平均与中位数。

### 活跃负载基线

请求样本按 5 分钟分桶。整体 24 小时算术平均仍然保留用于展示和参考，但它**不再是告警的主触发器**：
对低频用户来说，这个平均值会被大量空闲时间稀释，一次正常但集中的任务就会显得非常夸张。

主比值改为与**活跃负载基线中位数**比较：

```text
活跃分桶               = 该 5 分钟内请求数 ≥ minimumActiveRequests（默认 1）的分桶
activeBaseline.costPerHour = 活跃分桶的每小时成本 × 12 的中位数     取 [now − 24h, now − 1h]
activeRatio               = burn(最近1小时).costPerHour / activeBaseline.costPerHour
overallRatio              = burn(最近1小时).costPerHour / baseline24h.costPerHour   （仅作参考展示）
```

同一批活跃分桶还会给出请求速率（次/分钟）中位数、每请求未命中 Token 中位数和提示词大小中位数，
作为负载证据与效率证据的比较基准。

**基线预热。** 只有当 23 小时窗口内同时满足：活跃分桶 ≥ `minActiveBuckets`（6）、请求数 ≥
`baselineMinRequests`（30）、已观测历史 ≥ `baselineMinCoverageHours`（1 小时）时，基线才为 `ready`；
否则为 `warming`，并暴露 0..1 的置信度。预热期间消耗严重级别保持"正常"，消耗速率告警关闭，界面显示
"正在建立基线 / Learning baseline"。

### 严重级别

| 级别 | 含义 | 判定（默认值） |
|---|---|---|
| 正常（Normal） | 没有异常。 | 比值在基线范围内，且没有效率证据。 |
| 提示 / 偏高（Notice） | 相对你平时的活跃工作，用量偏高，但没有证据表明花费是低效的。 | 消耗比值 ≥ `warningBurnRatio`（2），或 ≥ `criticalBurnRatio`（4.5），但**没有**佐证。单纯的重任务停在这一级，不会成为告警。 |
| 警告（Warning） | 存在具体条件或可能的效率问题。 | 至少一个强效率信号（缓存下降到绝对健康值以下，或未命中 Token 突增）、绝对缓存问题，或 10 分钟成本尖峰。 |
| 严重（Critical） | 高消耗**且**有佐证的效率证据。 | 消耗比值 ≥ `criticalBurnRatio`（4.5）**且**至少一个强效率信号。将 `criticalRequiresSecondaryEvidence` 设为 `false` 才允许"高消耗本身"判为严重（不推荐）。 |

### 佐证证据

| 证据 | 类型 | 规则（默认值） |
|---|---|---|
| `request-rate` | 负载 | 最近 15 分钟请求速率 ≥ 活跃请求速率基线的 2 倍（且 ≥ 1 次/分钟） |
| `context-growth` | 负载 | 最近 1 小时平均提示词大小 ≥ 活跃提示词基线的 1.8 倍 |
| `cache-drop` | 效率 | 缓存差值 ≤ −5 个百分点 **且** 绝对命中率 < 90% |
| `uncached-burst` | 效率 | 最近 30 分钟未命中 Token ≥ 10,000 **且** 每请求未命中 Token ≥ 活跃基线的 3 倍 **且** 绝对命中率 < 90% |
| `session-dominance` | 仅佐证 | 单个会话占近期未命中 Token ≥ 70%；只在已有其他效率信号时记录，绝不单独触发告警 |

`criticalRequiresSecondaryEvidence` 开启时，只有 `cache-drop` 与 `uncached-burst` 能把消耗级别推高到
严重。`session-dominance` 只用于解释已有问题。

### 时间线上的条件

| 条件 | 精确规则（默认值） | 级别 |
|---|---|---|
| `burn-anomaly` | 消耗与效率证据合并后的条件，仅在警告/严重时产生；类型为 `cache-hit-drop`、`uncached-burst` 或 `burn-rate` | 警告 / 严重 |
| `cache-low` | 最近 1 小时命中率 `< cacheWarningRate`（0.5）且持续 `cacheAlertMinutes`（10 分钟）→ 警告；`< cacheCriticalRate`（0.3）→ 严重 | 警告 / 严重 |
| `cost-spike` | 最近 10 分钟估算成本 `> costSpike10m`（默认 5 个展示货币单位） | 警告 |
| `balance-low` | 余额低于配置阈值（默认 50 / 20 / 10）；触发的阈值越低级别越高 | 警告 / 严重 |
| `recovered` | 之前活跃的条件已连续 ≥ 2 分钟不再满足 | 信息 |

只有**警告**和**严重**的活跃条件会成为告警。提示会改变状态标签和说明，但不会产生告警。

**历史账本。** 时间线还会从已保存的请求记录重建 24 小时的 5 分钟分桶，但只保留有证据支撑的事件：

- `cache-hit-drop` —— 请求数 ≥ 5 的分桶，其命中率低于 50% 的绝对警告线，或相对 24 小时平均值下降
  ≥ 15 个百分点且仍低于 90%；
- `request-spike` —— 分桶请求数超过平均值 4 倍且至少 8 个请求（信息级）。

v0.1.1 移除了逐分桶重建的 `burn-rate` 历史记录，因为它是时间线误报的主要来源：一次重任务可能刷出
大量"异常"分桶。上面的实时评估已经覆盖真正的消耗异常。同类型连续分桶会合并，最多展示最新 20 条历史记录。

**它不是：** 不做季节性调整，不考虑节假日的用量变化（只影响计价），不对绝对 Token 量报警，
所有金额类规则都基于*估算*成本而非钱包余额。钱包只用于 `balance-low` 与已观测花费。

## 理解消耗速率告警

**消耗速率高并不一定意味着用量异常。** 一次长时间使用工具的任务、一个很大的上下文，或一批并行子代理，
天然会比空闲会话每小时花得更多。v0.1.1 的设计目标是如实标注这种"重活"，而不是对它报警。

*示例（仅用于说明）：* 一个低频用户可能同时处于"整体 24 小时平均的约 8.5 倍"和"活跃负载基线的约 0.6 倍"。
前一个数字大，是因为平均值包含大量空闲时间；后一个数字说明当前节奏对其真实工作而言是正常的。
插件按活跃负载比值告警，而不是按包含空闲时间的平均值。

### 判断流程

1. **基线门控。** 活跃基线仍在预热（新安装，或历史不足约 1 小时 / 6 个活跃 5 分钟分桶 / 30 次请求）时，
   消耗严重级别保持"正常"，消耗速率告警关闭；界面显示"正在建立基线"及置信度。
2. **比较活跃工作。** 最近 1 小时的估算每小时成本，除以活跃负载每小时成本中位数；24 小时算术平均只作参考。
3. **收集证据。** 负载信号（请求速率、上下文大小）与效率信号（缓存下降、未命中突增，以及仅作佐证的
   单会话集中）来自同一批数据。
4. **定级。** 没有证据的高消耗是**提示**（显示为用量偏高）；警告需要至少一个强效率信号或具体条件；
   **严重必须同时满足高消耗与强证据**。
5. **告警。** 只有警告与严重会成为告警；提示仅出现在状态标签、评估说明和时间线中。

### 各级别建议的处理方式

| 级别 | 建议 |
|---|---|
| 正常 | 无需处理，用量在活跃负载基线范围内。 |
| 提示 / 偏高 | 工作量大，但不一定浪费。在"消耗排行"里确认是哪个会话/轮次驱动；除非成本本身出乎意料，否则无需处理。 |
| 警告 | 打开"为什么用量偏高？"和缓存诊断。缓存下降或未命中突增可以解释额外花费，面板会列出证据与数字。 |
| 严重 | 高消耗与强证据同时成立，应按真实的效率问题处理：检查缓存证据、受影响会话，以及其中记录的
工具集/系统提示词变化。 |

这里没有预算，也没有预测：阈值比较的是*估算*成本，基线来自你自己的近期活跃历史，钱包仍是唯一权威的金额来源。

## 缓存诊断

缓存命中率计算公式：

```text
hitRate = cacheReadTokens / (cacheReadTokens + inputTokens + cacheWriteTokens)
```

插件只检查 Harness 已经记录的 Session 事件，并且只报告有记录证据的原因（见"为什么用量偏高？"面板）：

| 检查 | 记录的证据 | 说明 |
|---|---|---|
| **请求 epoch 变化** | `request/header` 事件中 reason 为 `change` 的次数与时间 | 工具、系统提示词或模型发生变化，可缓存前缀被迫重建 |
| **系统提示词哈希变化** | 同一会话内系统消息文本的不同截断 SHA-256 哈希数量 | 前缀无法保持稳定 |
| **工具集变化** | 请求头中出现过的不同工具列表长度 | 增删工具会使变化点之后的前缀失效 |
| **模型切换** | 同一会话内出现过的不同模型 ID | 服务商缓存按模型隔离，切换后首次请求必然未命中 |
| **压缩（compaction）断点** | `compaction/start` 事件次数 | 压缩会重写历史，压缩后的首次请求无法复用旧前缀 |
| **TTL 间隔** | 用量样本之间 > 30 分钟的间隔，以及间隔后首批样本的命中率 | 长时间空闲后服务商缓存很可能已过期 |
| **前缀中的时间戳 / UUID** | 系统消息文本中类 ISO 时间戳与 UUID 的**计数**（只存计数，不存文本） | 每次请求都重新生成的时间戳/UUID 会让前缀每次都不同 |
| **缓存未上报** | 上报零缓存计数的样本多于有缓存计数的样本的会话 | 模型/服务商可能不支持前缀缓存 |
| **上下文增长** | 最近 1 小时平均提示词规模达到活跃负载提示词基线的 1.8 倍 | 上下文增长不会破坏前缀，但会让每次未命中更贵 |
| **命中率下降 / 关联** | 最近 1 小时命中率对比当前小时之前的 24 小时窗口，并按 5 个百分点死区与 90% 绝对健康下限分类；只有真实下降才会成为诊断，与活跃消耗比值的关联单独报告 | 缓存未命中很可能是成本上升的驱动因素 |

只有最近 1 小时未缓存输入 Token 至少 5,000、且命中率低于全局 24 小时命中率的会话才会被评估。

**它无法证明什么：** 插件看不到服务商的缓存键与命中/未命中原因。记录到的请求头变化可能来自 Harness
配置调整而非缺陷；系统提示词中的时间戳可能是有意设计；TTL 间隔是从请求时间推断的，不是服务商上报。
这些都被标注为*可能*原因，而不是结论。系统提示词本身从不保存 —— 只保存截断哈希与计数。

## 如何理解缓存节省

缓存卡片上的数字标注为**缓存避免的额外输入费用**（Estimated avoided input cost），而不是"返还的钱"。
它回答的是一个反事实问题：*如果这些命中缓存的提示词 Token 按未命中价格计费，同样的请求会多花多少？*

```text
避免的额外输入费用 = Σ 每个请求 cacheReadTokens × (cacheMissPrice − cacheHitPrice) / 1,000,000
                    （最近 24 小时）
```

- 每个请求按它自己的模型、时间戳（高峰/空闲）与配置的价格覆盖计算，再求和。
- 它是**避免的额外成本**估算 —— 不是退款、不是平台返还、不是加到钱包里的钱，也不是可消费的抵扣。
- 工作负载本身提示词大、命中率又高时，这个数字自然可能很大；单凭它不能说明哪里有问题或特别好。

### 命中率差值是带死区的

卡片还会把最近 1 小时的命中率与当前小时之前的 24 小时窗口（`[now − 24h, now − 1h]`）比较。
v0.1.1 不会把每次波动都当成问题，而是先分类：

| 绝对差值（默认） | 分类 | 效果 |
|---|---|---|
| < 5 个百分点（`cacheDeltaDeadband`） | 中性 | 视为噪声。99.7% → 99.0% 只差 0.7 个百分点，保持健康。 |
| 5–15 个百分点 | 提示 | 值得关注；只有绝对命中率也偏低时才会成为问题。 |
| ≥ 15 个百分点（`cacheDeltaNotice`） | 警告级 | 绝对命中率同时低于健康下限（`cacheHealthyRate`，90%）时才是警告；高于该下限仍只是提示。 |

绝对健康状态使用固定下限：低于 `cacheWarningRate`（50%）为警告级，低于 `cacheCriticalRate`（30%）为严重级。
90% 的健康下限用于避免高命中率缓存因为小幅相对下降而被误报。低流量窗口可能出现
`deltaClass: "unknown"`；请求太少时不做任何推断。

## 数据与隐私

一切都在本地。完整清单见 [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md)，安全策略见 [`SECURITY.md`](SECURITY.md)。

| 问题 | 回答 |
|---|---|
| 数据存在哪里？ | `$DSH_HOME/usage-monitor/`（默认 `~/.dsh/usage-monitor/`）：`state.json`、`settings.json`，以及 `status.json`（支持快照，默认写入）。该目录被 git 忽略，且不位于包目录或配置目录内。 |
| 保存了什么？ | 聚合 Token 计数、钱包样本、会话标题/cwd/预设元数据、缓存信号计数与异常条件时间戳。**不保存提示词、不保存模型输出、不保存凭据。** |
| 有什么会离开本机？ | 除 Harness 自身的 `deepseekAccount` 服务向已登录 DeepSeek 账户发起的官方余额读取外，没有任何数据离开。插件自身不发起网络请求，没有遥测，不上传。 |
| 会读取 API Key 或 Cookie 吗？ | 不会。插件从不读取凭据；Harness 账户服务持有凭据，只返回解析后的钱包金额。 |
| 会保存我的提示词吗？ | 不会。为了缓存诊断，系统消息只会被归约为截断 SHA-256 哈希以及 UUID/时间戳计数。 |
| 数据保留多久？ | `retentionDays`，默认 **14 天**，可配置 1–30 天；每 10 分钟清理一次。钱包历史超过 720 个样本后会降采样。 |
| `status.json` 是什么？ | 不含提示词与凭据的小型支持快照；默认写入，可通过高级设置 `exposeDiagnosticsFile: false` 关闭。分享前请先检查。 |
| 如何删除全部数据？ | 移除 bundle，然后删除 `$DSH_HOME/usage-monitor/`。 |

插件对 Harness 数据是只读的：从不追加、重写或删除 Session 日志，只注册同源、需要认证的仪表盘路由。

## 开发

需要 Node.js ≥ 20；本地联调需要 DSH 0.2.1-rc.2。仓库没有依赖、没有构建步骤，无需安装任何东西。

```bash
npm test                          # node --test test/*.test.js
npm run check                     # 语法、JSON、清单、密钥、文档检查
npm run audit                     # 密钥/隐私扫描（工作区 + Git 历史）
npm run verify:live               # 需要本机真实运行：交叉校验 status 文件、state.json
                                  # 与原始 Session 日志 / Harness projection cache
```

CI 运行前三条命令（其中审计通过 `npm run audit` 调用）；`verify:live` 需要本机安装并运行 Harness 与插件。

| 路径 | 职责 |
|---|---|
| `index.js` | Host 入口：`apply`、`inject`、路由注册、index 注入 |
| `lib/monitor.js` | 引擎：Session 扫描、实时事件、钱包轮询、HTTP、生命周期 |
| `lib/ingest.js` | Session 事件折叠：用量计数与缓存信号 |
| `lib/analytics.js` | 快照聚合：窗口、消耗速率定级、活跃负载基线、评估、缓存、异常、消耗排行、预测 |
| `lib/pricing.js` | 官方价目表、高峰/空闲规则、成本估算 |
| `lib/store.js` | 设置校验、原子化本地状态、保留策略 |
| `client.js` | 浏览器端：侧边栏入口、面板、设置抽屉、i18n |
| `locale/` | 英文与简体中文显示文案 |
| `test/` | Node 测试运行器测试与合成 fixture |
| `docs/` | API 契约、架构、数据来源、UI 说明、路线图、截图 |

**安装开发副本：** 按[安装](#安装)步骤操作，但把路径指向你的开发克隆。修改 Host 文件后重载插件生效，
修改 `client.js` 后刷新窗口生效。测试时删除 `$DSH_HOME/usage-monitor/` 可重置状态。

**截图：** 仓库只接受真实本地 Harness 运行的截图 —— 绝不使用效果图。运行插件、打开面板、截取窗口，
对钱包金额/会话标题/路径脱敏，分别保存为 `docs/screenshots/dashboard.png` 与
`docs/screenshots/why-usage-high.png`。

更多细节：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md)、
[`docs/API.md`](docs/API.md)、[`docs/UI.md`](docs/UI.md)、[`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 已知限制

1. **Agent 身份是推导出来的，而非记录下来的。** Session 事件不包含逐请求的 Agent 名称；Agent 预设与子代理
   归因来自 Harness 的 Session 元数据（预设、子代理来源/父会话、cwd、会话标题）。
2. **"任务"是对话轮次。** 任务行表示某个会话的一轮对话，不是 Harness 的 job 或后台任务。
3. **已观测花费有起算时间。** 从插件第一次轮询钱包开始计算，没有历史余额回填；Token 历史则确实来自既有
   Session 日志。
4. **高峰/空闲计价不知道中国法定节假日**，除非把它作为高级设置配置（bundle 行或设置 API）。在配置前，
   节假日的请求会按高峰价估算。
5. **不包含 Search / Fetch 按次计费。** 该计费在北京时间 2026-11-01 前免费，插件未对其建模；插件估算的
   只有模型 Token 成本。
6. **仅 API Key 的配置没有余额。** 未登录 DeepSeek 账户时读不到钱包，但 Token 与估算成本面板仍可使用。
7. **估算不是账单。** Harness 没有内置成本计算器，也没有服务商账单历史 API；按会话/模型的金额都是
   Token 数量 × 公开价目表。
8. **活跃负载基线需要预热。** 只有过去 23 小时内积累了约 1 小时已观测历史、至少 `minActiveBuckets`（6）
   个活跃 5 分钟分桶和 `baselineMinRequests`（30）次请求后，消耗速率告警才会启用；新安装时显示
   "正在建立基线"，而不是猜测。
9. **缓存差值分类需要基线就绪**（以及足够的近期缓存请求）。死区与绝对健康下限可以避免小幅下降触发告警，
   但低流量窗口可能让差值为 `unknown`，此时不会凭空给出分类。
10. **单会话集中仅作佐证。** 一次大任务本来就可能在一个会话中占主导，因此会话占比本身从不产生告警，
    只在已发现其他效率信号时用于解释。

## 路线图

- 为定价层支持更多服务商适配。
- 通过 Harness 原生通知能力实现预算策略与通知。
- 用量报告导出（CSV / JSON，仅本地）。
- 更深入的缓存诊断（更可靠地定位根因，仍然不保存提示词）。
- 研究历史余额覆盖方案。

详见 [`docs/ROADMAP.md`](docs/ROADMAP.md)（含明确不做的方向）。

## 贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与
[`SECURITY.md`](SECURITY.md)。简而言之：不引入运行时依赖，不提交任何密钥或私有数据，所有结论都必须与代码
和 Harness 文档行为一致，英文与中文界面文案要同步更新。

## 许可证

MIT —— 见 [`LICENSE`](LICENSE)。Copyright (c) 2026 Freeman945。

本插件面向 **DeepSeek Harness** 开发，后者同样以 MIT 许可发布（Copyright (c) 2026 DeepSeek）：
<https://github.com/deepseek-ai/deepseek-harness>。DeepSeek 与 DeepSeek Harness 是其各自所有者的商标；
本项目是独立插件，与 DeepSeek 没有隶属或背书关系。
