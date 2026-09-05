# 华为鸿蒙系统推送接通指南

本文覆盖从 AGC 控制台、HarmonyOS NEXT 客户端到本仓库服务端的完整接通链路，并给出本项目（Huoqu 货代取件运营平台）的实测现状与排障方法。服务端只需配置一次，客户端/AGC 侧为一次性接入。

## 推送链路

```
业务事件（派单/状态变更…）
  → notifications + notification_deliveries（持久化投递队列）
  → dispatcher 轮询 → huawei 适配器（server/modules/notifications/providers/huawei.js）
  → 服务账号 JWT（PS256）换取访问令牌
  → POST https://push-api.cloud.huawei.com/v3/{项目ID}/messages:send
  → 华为 Push Kit → 鸿蒙系统通知栏横幅
```

订阅登记方向相反：鸿蒙端 `pushService.getToken()` 拿到设备 token 后，调用服务端

`POST /api/v1/notification-subscriptions`，body 形如：

```json
{
  "channel": "vendor_push",
  "providerCode": "huawei",
  "platform": "harmonyos",
  "deviceLabel": "HuoQu 鸿蒙原生端",
  "appVersion": "1.0.0",
  "token": "<pushService.getToken() 返回值>"
}
```

服务端加密保存并返回订阅 id；退出登录时 `DELETE /api/v1/notification-subscriptions/:id`。

> **一句话回答“需要填什么”**：Web「消息推送 → 华为 Push Kit」只需填两个字段——
> ① **Project ID**：AGC 控制台「项目设置 → 常规信息」里的项目 ID（18 位数字，本项目 `101653523864770079`，不是 `agconnect-services.json` 里的 `cp_id`）；
> ② **服务账号 JSON**：AGC「项目设置 → 服务账号」下载的 `<项目ID><数字>private.json` 全文（含 `key_id`、`sub_account`、`private_key`）。
> 不要把 `agconnect-services.json`（工程配置）当服务账号粘贴，服务端会直接给出针对性报错。
> 填完按「保存配置 → 连接测试 → 启用」三步走，页面出现「运行中」即完成。以下为完整说明。


## 一、AGC 控制台（一次性）

1. 登录 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html)，创建**鸿蒙（HarmonyOS）应用**，包名必须与工程 `AppScope/app.json5` 的 `bundleName` 一致：`com.cargo.pickupstats`。
2. 记录**项目 ID**（18 位数字，本项目为 `101653523864770079`）。注意：`agconnect-services.json` 里的 `client.cp_id` 是服务商 ID，**不是**项目 ID，服务端配置时不要填错。
3. 在「项目设置 → 管理」/ 服务列表开通 **Push Kit（推送服务）**。
4. 下载 `agconnect-services.json`，放到鸿蒙工程 `AppScope/` 下（同时确认 `module.json5` 的 metadata 里有 `client_id`，值等于该文件里的 `client_id`，本项目为 `2018153252817773568`）。
5. 在「项目设置 → 服务账号」创建/下载**服务账号 JSON**：内容包含 `key_id`、`sub_account`、`private_key` 三段，命名类似 `<项目ID><数字>private.json`。这份文件给服务端用（本项目已下载在服务器 `data/101653523864770079118652461private.json`），**不要**把 `agconnect-services.json` 当服务账号用。
6. 真机联调建议开启 DevEco 自动签名并保证 AGC 侧证书指纹一致；上架前需配置正式签名证书。`getToken()` 失败时优先检查 1/2/3/6 步。

## 二、HarmonyOS NEXT 客户端

1. 通知权限：HarmonyOS 通知默认关闭，应用启动后需调用 `notificationManager.requestEnableNotification()` 拉起系统授权弹窗（设置里为「通知与状态栏 → 应用 → 允许通知」）。没有授权则推送消息不展示，但 token 可能照常下发。
2. 获取并上报 token：登录成功后调用

   ```ts
   const token = await pushService.getToken()
   await ApiClient.post('/api/v1/notification-subscriptions', {
     channel: 'vendor_push', providerCode: 'huawei', platform: 'harmonyos',
     token, deviceLabel: 'HarmonyOS 设备', appVersion: '1.0.0'
   })
   ```

   建议采用“先删旧 id 再建新订阅”策略：卸载重装或 token 失效后，旧订阅不会自动清理，会在服务端积累失效 token。
3. 消息类型说明：服务端目前发送的是**通知消息**（payload 含 `notification` 段），由华为 Push Kit 直接弹出系统横幅，应用前台/后台都会展示，点击行为 `actionType: 0` 拉起 `EntryAbility`。`pushService.receiveMessage()` 只接收**数据消息**回调，因此不要用它判断“通知是否送达”；页面在前台时的即时刷新走项目已有的 SSE（`/api/v1/events`），两套机制互相独立。
4. 排查时用 hilog 抓客户端日志：本项目相关 tag 为 `CargoPush`（token 注册）与 `CargoNotify`（本地通知）。

## 三、服务端配置（本仓库）

1. `.env` 必须配置 `PUSH_CONFIG_MASTER_KEY`（用于加密保存推送凭据，已配置）。
2. 管理员登录 Web → 「消息推送」→ 华为 Push Kit：
   - Project ID：`101653523864770079`（你的 AGC 项目 ID）
   - 服务账号 JSON：把 AGC 下载的服务账号 JSON **全文**粘贴进去（生产服务器本地文件 `data/101653523864770079118652461private.json` 就是它）
3. 依次执行：**保存配置 → 连接测试 → 启用**。
   - 当前生产库（2026-09-05 实测）：`enabled=1 / healthStatus=healthy / config_version=tested_version=6`，页面应显示「运行中」；**不要重复保存覆盖**。只有凭据失效（AGC 侧删了服务账号或换项目）才需要重填。
   - 保存/测试返回 `HUAWEI_CONFIG_INVALID` 时，新版服务端会直接提示缺哪个字段或“像 agconnect-services.json”，按提示修正。
   - 成功标志：页面显示“运行中”/ `healthStatus=healthy`、`enabled=true`。
4. 部署生效：容器镜像内含代码，改动后需 `docker compose up -d --build huoqu` 重建。

## 四、验证

1. **确认订阅存在**：用鸿蒙端登录账号查询设备列表（Web「通知设置」页或 `GET /api/v1/notification-subscriptions`），应能看到 `providerCode=huawei / platform=harmonyos / status=active` 的设备。
2. **触发推送**：用“拥有华为订阅的账号”在通知设置里点「发送测试通知」；或由客服给该取件员派单。注意：管理员后台的测试只发给管理员自己，若管理员没有华为订阅就不会产生华为投递，这不算故障。
3. **看投递结果**：管理端投递列表或数据库 `notification_deliveries` 中 `provider_code='huawei'` 的行应为 `status='sent'`（几秒内）。
4. **看手机**：通知栏出现横幅（“推送测试 / 消息推送配置正常”等）；点击后打开应用。

## 五、排障速查

| 现象 | 检查点 |
| --- | --- |
| 连接测试 `HUAWEI_CONFIG_INVALID` | Project ID 是否填成 `cp_id`；服务账号 JSON 是否是 AGC 服务账号 JSON（含 `key_id/sub_account/private_key`），而不是 `agconnect-services.json` |
| 配置 healthy 但投递 `PROVIDER_NOT_ACTIVE` | 通道未“启用”；在消息推送页点启用 |
| 投递一直 `pending` | 通道停用期间积累，启用后按重试计划自动补发；若最终 `failed` 可在管理端手动重试 |
| 投递 `sent` 但手机不弹 | ① 手机未授权通知（设置→通知）② 鸿蒙端未调 `requestEnableNotification()` ③ 服务端 category 与 AGC 自分类权益不匹配会被降级（本项目应恒为 `WORK`=工作事项提醒；若改成 `EXPRESS` 等未获批分类，通知只进栏、息屏不响不振）④ 系统“通知智能管理/免打扰” ⑤ 应用被卸载重装导致 token 失效（旧订阅残留） |
| 鸿蒙端 `getToken()` 失败 | AGC 是否开通 Push Kit；`agconnect-services.json` 是否与工程包名匹配；`module.json5` 的 `client_id`；自动签名/证书；抓 hilog 错误码后对照 AGC 文档 |
| 服务端根本没生成 huawei 投递 | 通知接收人与订阅用户不一致；用户通知偏好里 `vendor_push` 被关闭（`notification_preferences`）；订阅 `status=invalid` |
| 一批投递整体 `failed`（非 80000000） | 该批中可能混入失效 token；服务端当前对整批结果处理，建议清理失效订阅后再试 |
| 投递返回码 `80300007`（全部 Token 无效） | 新版服务端会把该订阅自动置为 `invalid`（不再反复重试）。HarmonyOS 3.x/4.x 升级到 5.0 后 Push Token 必须重新获取：在鸿蒙端重新登录触发 `getToken()` 重新注册，并删除旧订阅 |
| 投递 `sent`、网关返回 80000000 但手机没弹 | 问题不在服务端/接口，按「四、验证 → 4」的客户端清单查：通知权限、`requestEnableNotification()`、通知分类/免打扰、包名与签名是否与 AGC 一致 |

## 六、本项目现状（2026-09-05 实测）

- 服务端华为通道**已配置且启用**：`enabled=1 / healthStatus=healthy / config_version=tested_version=6`，最近一次连接测试 09-05 02:03 UTC 通过。
- 存库凭据与本地 `data/101653523864770079118652461private.json` **逐字段一致**（Project ID、`key_id`、`sub_account`、`private_key` 哈希比对通过），不是 `agconnect-services.json`。
- 网关实测：09-05 03:38–03:41 UTC 对 3 条活跃鸿蒙订阅逐一发送，华为全部返回 `code=80000000 Success` 并给出 requestId；此前 09-04 18:48–09-05 01:24 另有 103 条投递记录为 `sent`。**服务端 → 华为 Push Kit → 设备通道已被网关受理，接口无需再改配置。**
- 数据库 3 条 `huawei` 订阅归属取件员账号：09-05 00:41（最新，`HarmonyOS Device`）、09-04 15:27（`HuoQu 鸿蒙原生端`）、09-03 02:49（`HarmonyOS 设备`）。三条 token 当前都被网关接受，但卸载重装/系统升级后旧 token 会逐步失效，建议在鸿蒙端以“删旧建新”策略重新注册。
- 若手机此时仍未弹通知：请按第四节第 4 条与第五节逐项检查手机端（权限、免打扰、包名/签名与 AGC 一致）。服务端记录 `sent` 且网关 80000000 时，问题只可能出在手机/客户端，不在本仓库。
