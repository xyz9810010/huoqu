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
   - 服务账号 JSON：把 AGC 下载的服务账号 JSON **全文**粘贴进去
3. 依次执行：**保存配置 → 连接测试 → 启用**。
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
| 投递 `sent` 但手机不弹 | ① 手机未授权通知（设置→通知）② 鸿蒙端未调 `requestEnableNotification()` ③ 通知分类被折叠/关闭（服务端 category 为 `EXPRESS`，留意“货运/快递”类分组）④ 系统“通知智能管理/免打扰” ⑤ 应用被卸载重装导致 token 失效（旧订阅残留） |
| 鸿蒙端 `getToken()` 失败 | AGC 是否开通 Push Kit；`agconnect-services.json` 是否与工程包名匹配；`module.json5` 的 `client_id`；自动签名/证书；抓 hilog 错误码后对照 AGC 文档 |
| 服务端根本没生成 huawei 投递 | 通知接收人与订阅用户不一致；用户通知偏好里 `vendor_push` 被关闭（`notification_preferences`）；订阅 `status=invalid` |
| 一批投递整体 `failed`（非 80000000） | 该批中可能混入失效 token；服务端当前对整批结果处理，建议清理失效订阅后再试 |

## 六、本项目现状（2026-09-05）

- 华为通道凭据曾于 09-04 被误改（Project ID 填成 `cp_id`、服务账号贴成 `agconnect-services.json`），目前 `enabled=0 / health=failed / HUAWEI_CONFIG_INVALID`，需按第三节重新配置并启用。
- 数据库有 3 条 `huawei` 订阅（归属取件员账号 `www`）：两条 09-04 有更新，一条 09-03 注册后未再更新（可能已失效，建议在鸿蒙端重新登录触发新注册并清理旧订阅）。
- 正确服务账号文件在服务器 `data/101653523864770079118652461private.json`，可直接取其内容粘贴。
