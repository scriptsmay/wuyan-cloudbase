# wuyan-cloudbase API 接口文档

> 最后更新：2026-07-20  
> 基础域名：`https://trial-sh-d1gqznm4577d6a062-1251520283.ap-shanghai.app.tcloudbase.com`

## 目录

- [鉴权说明](#鉴权说明)
- [统一错误响应](#统一错误响应)
- [1. GET /api/overview — 赛季概览](#1-get-apioverview--赛季概览)
- [2. GET /api/live — 直播记录](#2-get-apilive--直播记录)
- [3. GET /api/schedule — 赛程数据](#3-get-apischedule--赛程数据)
- [4. GET /api/story — 周故事卡](#4-get-apistory--周故事卡)
- [5. GET /api/heroes — 英雄统计](#5-get-apiheroes--英雄统计)
- [6. GET /api/config — 应用配置](#6-get-apiconfig--应用配置)
- [7. POST /api/cheer — AI 应援文案](#7-post-apicheer--ai-应援文案)
- [8. POST /api/ask — 小秘书智能问答](#8-post-apiask--小秘书智能问答)
- [9. POST /api/checkins — 每日打卡](#9-post-apicheckins--每日打卡)
- [10. GET /api/checkins/me — 我的打卡状态](#10-get-apicheckinsme--我的打卡状态)
- [11. GET /api/checkins/me/report — 今日加油卡](#11-get-apicheckinsmereport--今日加油卡)
- [12. GET /api/checkins/stats — 今日打卡统计](#12-get-apicheckinsstats--今日打卡统计)
- [13. GET /api/auth/me — 当前认证身份](#13-get-apiauthme--当前认证身份)
- [14. POST /api/auth/transfer/start — 创建匿名迁移票据](#14-post-apiauthtransferstart--创建匿名迁移票据)
- [15. POST /api/auth/transfer/complete — 完成跨端数据迁移](#15-post-apiauthtransfercomplete--完成跨端数据迁移)

---

## 鉴权说明

项目存在**两套鉴权体系**，由各端点独立选择：

| 鉴权方式 | 适用端点 | 实现 |
|---------|---------|------|
| **Query Token**（旧） | `get-overview`, `get-live`, `get-schedule`, `get-story`, `get-heroes` | URL 参数 `?token=<AUTH_TOKEN>`，比对环境变量 |
| **Bearer Session**（新） | `ai-cheer`, `ask`, `checkin` | `Authorization: Bearer <CloudBase access_token>` |
| **无鉴权** | `get-config`, `checkins/stats` | 公开接口 |

**Bearer 鉴权流程**：
1. 前端通过 `@cloudbase/js-sdk` 建立匿名会话，获取 `access_token`
2. 每次请求携带 `Authorization: Bearer <access_token>` 头
3. 云函数调用 CloudBase Auth introspection API 验证 token，提取 `subject_id`

**旧鉴权 token**：`wuyan_mini_20260710`（环境变量 `AUTH_TOKEN`），仅用于兼容小程序调用方。

**正式账号登录**：Web 端通过 CloudBase Auth 的 `auth.signInWithPassword({ username, password })` 登录。账号只能由管理员在 CloudBase Auth 控制台预创建，前端不提供注册、手机号、短信或 OAuth 登录。

---

## 统一错误响应

所有 Bearer 鉴权端点的错误响应体：

```json
{
  "code": "<ERROR_CODE>",
  "message": "<人类可读错误描述>",
  "request_id": "<UUID>"
}
```

旧鉴权端点的错误响应体：

```json
{
  "code": <HTTP_STATUS>,
  "message": "<错误描述>",
  "data": null
}
```

### 通用错误码

| HTTP | `code` | 触发条件 |
|------|--------|---------|
| 400 | `INVALID_ARGUMENT` | 请求体不是合法 JSON、必填字段缺失或不合法 |
| 401 | `SESSION_REQUIRED` | 无有效匿名会话或会话已过期 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 不支持的 HTTP 方法 |
| 429 | `RATE_LIMITED` | 用户/IP/全局调用额度用尽，含 `retry_after` 秒数 |
| 451 | `CONTENT_BLOCKED` | 输入或输出命中内容安全检查 |
| 503 | `AI_UNAVAILABLE` | AI 模型调用失败 |
| 503 | `WRITE_FAILED` | 数据库写入或事务失败 |

---

## 1. GET /api/overview — 赛季概览

> 云函数：`get-overview` | 鉴权：Query Token

返回当前赛季无言选手的核心数据概览。

**请求**

```
GET /api/overview?token=<AUTH_TOKEN>
```

**响应 200**

```json
{
  "code": 200,
  "message": "ok",
  "data": {
    "season": "2026S2",
    "season_name": "2026 KPL 夏季赛",
    "player_name": "无言",
    "team_name": "KSG",
    "updated_at": "2026-07-13T04:00:00.000Z",
    "overview": {
      "player_info": { /* 选手基础信息 */ },
      "career_summary": { "total_matches": 120, "kda_ratio": 3.5, "win_rate": 0.58 },
      "current_season": { "season_id": "2026S2", "battles": 45, "win_rate": 0.6, "kda_ratio": 3.8, "mvp": 5, "avg_kills": 2.1, "avg_deaths": 1.3, "avg_assists": 4.5 },
      "hero_top": [
        { "hero_name": "公孙离", "battles": 12, "win_rate": "66.7%" },
        { "hero_name": "孙尚香", "battles": 9, "win_rate": "55.6%" }
      ],
      "team_stats": [],
      "recent_matches": []
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `overview.current_season` | object | 当前赛季统计，由 `season_id` 匹配 |
| `overview.hero_top` | array | 按出场次数降序，最多 10 个英雄 |
| `overview.career_summary` | object | 生涯汇总，当赛季无数据时作为回退 |

---

## 2. GET /api/live — 直播记录

> 云函数：`get-live` | 鉴权：Query Token

返回指定月份的直播记录与动态汇总。

**请求**

```
GET /api/live?token=<AUTH_TOKEN>&year=2026&month=7
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `year` | 当前年份 | 整数 |
| `month` | 当前月份 | 整数 |

**响应 200**

```json
{
  "code": 200,
  "data": {
    "year": 2026,
    "month": 7,
    "is_current": true,
    "summary": {
      "total_days": 8,
      "total_sessions": 12,
      "total_hours": 24.5,
      "avg_hours_per_session": 2.0,
      "computed": true
    },
    "streams": [
      {
        "stream_date": "2026-07-13",
        "duration": 7200,
        "title": "晚间排位",
        "stream_url": "https://..."
      }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `summary` | 动态实时计算（不依赖月度缓存），无数据时为 `null` |
| `summary.computed` | 始终为 `true`（标识为实时计算） |
| `streams` | 排除 `type: "monthly_summary"` 的记录 |

---

## 3. GET /api/schedule — 赛程数据

> 云函数：`get-schedule` | 鉴权：Query Token

返回最新或指定赛季的赛程缓存。

**请求**

```
GET /api/schedule?token=<AUTH_TOKEN>
GET /api/schedule?token=<AUTH_TOKEN>&seasonid=2026S2
```

| 参数 | 说明 |
|------|------|
| `seasonid` | 可选，不传时返回最新赛程 |

**响应 200**

```json
{
  "code": 200,
  "data": {
    "season_name": "2026 KPL 夏季赛",
    "matches": [
      {
        "team_a": "KSG",
        "team_b": "AG",
        "start_ts": 1750521600,
        "status": 4,
        "score_a": 3,
        "score_b": 1,
        "stage": "常规赛第三轮",
        "schedule_id": "xxx"
      }
    ],
    "updated_at": "2026-07-13T06:00:00.000Z",
    "last_live_synced_at": "2026-07-13T12:05:00.000Z",
    "sync_mode": "live",
    "window_active": true
  }
}
```

| 字段 | 说明 |
|------|------|
| `sync_mode` | `"live"` 或 `"daily"`，即时计算 |
| `window_active` | 当前是否在比赛活跃窗口内 |
| `last_live_synced_at` | 最近一次实时同步成功时间 |
| `matches[].status` | 赛程状态（业务定义） |
| `matches[].score_a/b` | 仅 `status=4`（已完赛）时有效 |

无数据时返回 `503`。

---

## 4. GET /api/story — 周故事卡

> 云函数：`get-story` | 鉴权：Query Token

返回最新或指定周的故事卡文案与统计数据。

**请求**

```
GET /api/story?token=<AUTH_TOKEN>
GET /api/story?token=<AUTH_TOKEN>&week=2026-W28
```

**响应 200**

```json
{
  "code": 200,
  "data": {
    "week": "2026-W28",
    "season_name": "2026 KPL 夏季赛",
    "text": "本周无言选手...",
    "stats": {
      "win_rate_diff": 3.5,
      "kda_diff": 0.2,
      "battles_diff": 5
    },
    "cover_color": "#0a0e1a",
    "created_at": "2026-07-13T01:00:00.000Z",
    "hero": { "name": "公孙离", "win_rate": 66.7 },
    "live_hours": 24.5
  }
}
```

| 字段 | 说明 |
|------|------|
| `stats.win_rate_diff` | 胜率变化（百分点），兼容驼峰/下划线/嵌套格式 |
| `hero` | 当前赛季出场最多英雄 |
| `live_hours` | 当月直播总时长，动态实时计算 |
| `text` | AI 生成的故事卡文案 |

---

## 5. GET /api/heroes — 英雄统计

> 云函数：`get-heroes` | 鉴权：Query Token

返回完整英雄统计数据（用于英雄池展示）。

**请求**

```
GET /api/heroes?token=<AUTH_TOKEN>
```

**响应 200**

```json
{
  "code": 200,
  "data": {
    "season": "2026S2",
    "season_name": "2026 KPL 夏季赛",
    "player_name": "无言",
    "team_name": "KSG",
    "updated_at": "2026-07-13T04:00:00.000Z",
    "hero_stats": [
      { "hero_name": "公孙离", "battles": 12, "win_rate": "66.7%", "kda_ratio": 4.2, "avg_kills": 3.1, "avg_deaths": 1.2, "avg_assists": 4.8 },
      { "hero_name": "孙尚香", "battles": 9, "win_rate": "55.6%", "kda_ratio": 3.5 }
    ]
  }
}
```

---

## 6. GET /api/config — 应用配置

> 云函数：`get-config` | 鉴权：无（公开接口）

返回 AI 模块的每日调用限制配置。

**请求**

```
GET /api/config
```

无需鉴权，但受 CORS 白名单限制。

**响应 200**

```json
{
  "code": 200,
  "data": {
    "ask_daily_limit": 10,
    "cheer_daily_limit": 10
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `ask_daily_limit` | 10 | 小秘书每日每 UID 次数 |
| `cheer_daily_limit` | 10 | AI 应援每日每 UID 次数 |

缓存：响应含 `Cache-Control: public, max-age=60`。

---

## 7. POST /api/cheer — AI 应援文案

> 云函数：`ai-cheer` | 鉴权：Bearer Session

根据心情生成应援文案，数据引用自最新赛季快照。

**请求**

```
POST /api/cheer
Authorization: Bearer <access_token>
Content-Type: application/json
X-Request-Id: <UUID>  (可选，用于幂等)
```

```json
{
  "mood": "daily",
  "text": "今天也来给你加油",
  "client_id": "1c083ee1-f749-48dd-bff2-65451a94f192"
}
```

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `mood` | string | 否 | `victory` / `low` / `daily` / `hope`，默认 `daily` |
| `text` | string | 否 | 补充文字，最多 120 个 Unicode 字符 |
| `client_id` | string | 是 | 客户端标识，`[a-zA-Z0-9:_-]{8,80}` |

**响应 200**

```json
{
  "code": 200,
  "data": {
    "lines": [
      "每一天的坚持，都是通往冠军的路 💙",
      "无言加油，我们永远是你的后盾"
    ],
    "emoji_caption": "陪伴是最长情的告白 💙",
    "report_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "refs": [
      { "label": "当前赛季 KDA", "value": "3.8", "source": "season_summaries" },
      { "label": "当前赛季胜率", "value": "60.0%", "source": "season_summaries" }
    ],
    "source_snapshot_at": "2026-07-13T04:00:00.000Z"
  }
}
```

| 字段 | 说明 |
|------|------|
| `lines` | 恰好 3 条应援文案，每条 30-50 个汉字 |
| `report_id` | AI 产出追溯 ID，存储在 `ai_reports` 集合 |
| `refs` | 文案中引用的数据来源，最多 3 条 |
| `source_snapshot_at` | 数据快照时间，文案仅基于此时点数据 |

**限流**：三级限流（UID 10 次/日、IP 30 次/日、全局 500 次/日），任一命中返回 429。

**幂等**：同一 `subject_id` + `X-Request-Id` 组合重复请求返回缓存结果，不重复计费。

**内容安全**：输入和输出均检查，拦截返回 451。

---

## 8. POST /api/ask — 小秘书智能问答

> 云函数：`ask` | 鉴权：Bearer Session

AI 小秘书，回答无言选手的赛事数据问题。基于 `season_summaries`、`live_streams`、`match_schedules` 注入上下文。

**请求**

```
POST /api/ask
Authorization: Bearer <access_token>
Content-Type: application/json
X-Request-Id: <UUID>  (可选)
```

```json
{
  "q": "无言最近状态怎么样",
  "client_id": "1c083ee1-f749-48dd-bff2-65451a94f192"
}
```

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `q` | string | 是 | 问题，最多 200 个字符 |
| `client_id` | string | 是 | 客户端标识 |

**响应 200**

```json
{
  "code": 200,
  "data": {
    "answer": "无言最近状态不错！本赛季胜率 60%，KDA 3.8，常用英雄公孙离胜率 66.7%。这个月已经直播了 24.5 小时，最近一场是 7 月 13 日～",
    "refs": ["当前赛季概览", "本月直播数据", "赛程数据"]
  }
}
```

| 字段 | 说明 |
|------|------|
| `answer` | AI 生成的回答，口语化中文 |
| `refs` | 使用的数据源标识数组 |

**缓存**：完全相同的问题 MD5 后缓存 5 分钟。

**限流**：每日每 UID 10 次（可通过 `app_config.ai_limits` 调整）。

---

## 9. POST /api/checkins — 每日打卡

> 云函数：`checkin` | 鉴权：Bearer Session

创建一个新的每日打卡记录。同一 `subject_id` + Asia/Shanghai 自然日只能打卡一次。

**请求**

```
POST /api/checkins
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "client_id": "1c083ee1-f749-48dd-bff2-65451a94f192",
  "report_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `client_id` | string | 是 | `[a-zA-Z0-9:_-]{8,80}` |
| `report_id` | string | 否 | 关联的 AI 应援 `report_id`，最多 80 字符 |

> ⚠️ 请求中不可传入 `subject_id` 或 `date`（由服务端计算，客户端传值会被忽略并记录安全日志）。

**响应 200**

```json
{
  "code": 200,
  "data": {
    "checkin": {
      "subject_id": "anon:xxx",
      "date": "2026-07-13",
      "tz": "Asia/Shanghai",
      "streak": 5,
      "total_days": 12,
      "report_id": "a1b2c3d4...",
      "created_at": "2026-07-13T12:00:00.000Z",
      "updated_at": "2026-07-13T12:00:00.000Z"
    },
    "already_checked_in": false,
    "today_count": 8
  }
}
```

| 字段 | 说明 |
|------|------|
| `checkin.streak` | 连续打卡天数（跨日 00:00 后重置） |
| `checkin.total_days` | 累计打卡天数 |
| `already_checked_in` | 幂等重放时为 `true`，首次创建为 `false` |
| `today_count` | 当日打卡总人数 |

**并发安全**：确定性文档 ID（`sha256(subjectId:YYYY-MM-DD)`）+ 数据库事务，支持自动重试 3 次。

**限流**：每 UID 10 次/分钟、每 IP 60 次/分钟。

---

## 10. GET /api/checkins/me — 我的打卡状态

> 云函数：`checkin` | 鉴权：Bearer Session

返回当前匿名用户的打卡累计信息。

**请求**

```
GET /api/checkins/me
Authorization: Bearer <access_token>
```

**响应 200**

```json
{
  "code": 200,
  "data": {
    "checked_in_today": true,
    "streak": 5,
    "total_days": 12,
    "today": {
      "date": "2026-07-13",
      "tz": "Asia/Shanghai",
      "streak": 5,
      "total_days": 12,
      "report_id": "a1b2c3d4...",
      "created_at": "2026-07-13T12:00:00.000Z",
      "updated_at": "2026-07-13T12:00:00.000Z"
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `checked_in_today` | 今日是否已打卡 |
| `today` | 仅已打卡时存在，当日打卡记录 |

---

## 11. GET /api/checkins/me/report — 今日加油卡

> 云函数：`checkin` | 鉴权：Bearer Session

返回当前匿名用户今日通过 AI 应援生成的加油卡内容。仅在今日已打卡关联了 `report_id` 时返回，否则返回 404。

**请求**

```
GET /api/checkins/me/report
Authorization: Bearer <access_token>
```

**响应 200**

```json
{
  "code": 200,
  "data": {
    "lines": [
      "每一天的坚持，都是通往冠军的路 💙",
      "无言加油，我们永远是你的后盾"
    ],
    "emoji_caption": "陪伴是最长情的告白 💙",
    "report_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "refs": [
      { "label": "当前赛季 KDA", "value": "3.8", "source": "season_summaries" }
    ],
    "source_snapshot_at": "2026-07-13T04:00:00.000Z"
  }
}
```

| 字段 | 说明 |
|------|------|
| `lines` | 加油卡文案行数组 |
| `emoji_caption` | 尾缀 Emoji 短语 |
| `report_id` | AI 产出追溯 ID |
| `refs` | 文案数据引用，同 `POST /api/cheer` 格式 |
| `source_snapshot_at` | 数据快照时间 |

**缓存**：无缓存，每次查询实时读取当日打卡记录和关联 AI 报告。

**错误响应**：今日未打卡或打卡未关联 `report_id` 时返回 `404 NOT_FOUND`。

---

## 12. GET /api/checkins/stats — 今日打卡统计

> 云函数：`checkin` | 鉴权：无（公开接口）

返回当日全站打卡人数。

**请求**

```
GET /api/checkins/stats
```

无需鉴权（受 CORS 白名单限制）。

**响应 200**

```json
{
  "code": 200,
  "data": {
    "date": "2026-07-13",
    "today_count": 8,
    "updated_at": "2026-07-13T12:00:00.000Z"
  }
}
```

---

## 13. GET /api/auth/me — 当前认证身份

> 云函数：`auth` | 鉴权：Bearer Session（匿名/正式）

返回当前会话的认证身份信息，包括 UID、用户名和登录模式。

**请求**

```
GET /api/auth/me
Authorization: Bearer <access_token>
```

**响应 200**

```json
{
  "code": 200,
  "data": {
    "uid": "anon:xxx",
    "username": "",
    "mode": "anonymous"
  }
}
```

| 字段 | 说明 |
|------|------|
| `uid` | 用户唯一标识（CloudBase sub） |
| `username` | 正式账号用户名，匿名时为空 |
| `mode` | `"anonymous"`（匿名会话）或 `"authenticated"`（正式登录） |

---

## 14. POST /api/auth/transfer/start — 创建匿名迁移票据

> 云函数：`auth` | 鉴权：Bearer 匿名 Session

为当前匿名会话创建一次性数据迁移票据，用于将打卡记录、AI 应援报告等数据迁移到正式账号。

**请求**

```
POST /api/auth/transfer/start
Authorization: Bearer <access_token>
Content-Type: application/json
```

无需请求体。

**响应 200**

```json
{
  "code": 200,
  "data": {
    "transfer_id": "transfer_a1b2c3d4e5f6...",
    "ticket": "base64url-ticket-string",
    "expires_at": "2026-07-20T13:00:00.000Z",
    "source_uid": "anon:xxx"
  }
}
```

| 字段 | 说明 |
|------|------|
| `transfer_id` | 迁移记录 ID（数据库文档 ID） |
| `ticket` | 迁移票据，客户端暂存，供 `complete` 接口消费 |
| `expires_at` | 票据过期时间（10 分钟） |
| `source_uid` | 源匿名 UID |

**错误响应**：已登录正式账号返回 `409 TRANSFER_NOT_ANONYMOUS`。

---

## 15. POST /api/auth/transfer/complete — 完成跨端数据迁移

> 云函数：`auth` | 鉴权：Bearer 正式 Session

使用迁移票据将匿名数据合并到当前正式账号。幂等：同一票据重复请求返回缓存结果，不重复迁移。

**请求**

```
POST /api/auth/transfer/complete
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "ticket": "base64url-ticket-string"
}
```

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `ticket` | string | 是 | `[A-Za-z0-9_-]{40,100}` |

**响应 200**

```json
{
  "code": 200,
  "data": {
    "transfer_id": "transfer_a1b2c3d4e5f6...",
    "migrated": {
      "checkins": 3,
      "users": 1,
      "ai_reports": 5
    },
    "completed_at": "2026-07-20T12:05:00.000Z"
  }
}
```

| 字段 | 说明 |
|------|------|
| `migrated.checkins` | 迁移的打卡明细数 |
| `migrated.users` | 迁移的用户统计（0 或 1） |
| `migrated.ai_reports` | 迁移的 AI 报告数 |

**并发安全**：使用 `transfer.status` 乐观锁（`pending → processing → completed`），失败自动回滚到 `pending`。

**错误响应**：

| HTTP | `code` | 触发条件 |
|------|--------|---------|
| 400 | `INVALID_ARGUMENT` | 票据格式不合法 |
| 401 | `AUTHENTICATED_SESSION_REQUIRED` | 当前为匿名会话，需先正式登录 |
| 404 | `TRANSFER_NOT_FOUND` | 票据不存在或已失效 |
| 410 | `TRANSFER_EXPIRED` | 票据已过期（创建超过 10 分钟） |
| 409 | `TRANSFER_IN_PROGRESS` | 迁移正在处理中，请稍后重试 |

---

## 附录 A：鉴权矩阵

| 端点 | HTTP 方法 | 鉴权 |
|------|----------|------|
| `/api/overview` | GET | Query Token |
| `/api/live` | GET | Query Token |
| `/api/schedule` | GET | Query Token |
| `/api/story` | GET | Query Token |
| `/api/heroes` | GET | Query Token |
| `/api/config` | GET | 无（CORS） |
| `/api/cheer` | POST | Bearer Session |
| `/api/ask` | POST | Bearer Session |
| `/api/checkins` | POST | Bearer Session |
| `/api/checkins/me` | GET | Bearer Session |
| `/api/checkins/me/report` | GET | Bearer Session |
| `/api/checkins/stats` | GET | 无（CORS） |
| `/api/auth/me` | GET | Bearer Session（匿名/正式） |
| `/api/auth/transfer/start` | POST | Bearer 匿名 Session |
| `/api/auth/transfer/complete` | POST | Bearer 正式 Session |

## 附录 B：CORS 白名单

所有 Bearer 鉴权端点 + `get-config` 使用受限 CORS（`ALLOWED_ORIGINS` 环境变量）：

- `https://trial-sh-d1gqznm4577d6a062-1251520283.tcloudbaseapp.com`
- `https://wuyan-ai-cheer-trial-sh-d1gqznm4577d6a062.webapps.tcloudbase.com`
- `http://localhost:5173`（仅 `ALLOW_LOCALHOST=true` 时）

旧鉴权端点（`get-*`）使用 `Access-Control-Allow-Origin: *`。

## 附录 C：数据库集合

| 集合 | 用途 | 相关接口 |
|------|------|---------|
| `season_summaries` | 赛季聚合数据 | `/overview`, `/story`, `/heroes`, `/cheer`, `/ask` |
| `live_streams` | 直播记录 | `/live`, `/story`, `/ask` |
| `match_schedules` | 赛程缓存 | `/schedule`, `/ask` |
| `weekly_story` | 周故事卡 | `/story` |
| `ai_reports` | AI 产出追溯 | `/cheer`, `/ask`, `/checkins/me/report` |
| `ask_cache` | 问答缓存（5min TTL） | `/ask` |
| `checkins` | 打卡明细 | `/checkins` |
| `checkin_users` | 个人累计 | `/checkins/me` |
| `checkin_daily_stats` | 每日统计 | `/checkins/stats` |
| `usage_limits` | 限流计数器 | 全部 AI/打卡接口 |
| `app_config` | 动态配置 | `/config` |
| `auth_transfers` | 匿名到正式 UID 的一次性迁移票据 | `/auth/transfer/*` |

## 附录 D：变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-13 | 初始版本：基于源码逐接口提取，覆盖全部 11 个 HTTP 端点 |
| 2026-07-13 | 修复 `.doc().set()` 中的 `_id` 字段问题，更新 `ALLOWED_ORIGINS` CORS 白名单 |
| 2026-07-20 | 新增 `GET /api/checkins/me/report` 接口，新增认证云函数三个接口 `/api/auth/*` |
