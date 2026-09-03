# 统一为 Node、Vue 和 HarmonyOS

项目以现有 Node.js + SQLite 生产系统为唯一数据与业务核心，采用第二个项目的 Vue 3 Web 管理端作为唯一 Web 界面，并保留现有 ArkTS 鸿蒙端。拒绝继续并行维护原生单页 Web、Spring Boot/Postgres 后端和 Android 客户端，因为它们会产生重复业务模型、重复部署和跨端状态不一致；统一后 Web 与鸿蒙端通过同一取件任务接口工作。

