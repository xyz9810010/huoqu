# 工程与容器基线运行手册

## 验证源码与配置

运行 `npm run check:artifacts`，预期输出 `source-artifacts=clean`。

运行 `npm run check:compose`，预期输出 `compose-config=valid`。

## Linux 容器测试

运行 `npm run test:container`。测试服务不挂载 `./data`，因此不会访问正式数据库。

## 隔离烟雾测试

运行 `npm run smoke:container`。默认使用端口 33000 和 `/tmp/huoqu-smoke.*` 临时目录，测试结束自动清理。

## 生产启动

运行 `docker compose up -d --build`，再运行 `docker compose ps`。服务状态应为 `healthy`，访问地址为 `http://<NAS-IP>:3000`。

## 在线备份

运行：

```bash
docker compose exec -T huoqu npm run backup -- "$(date -u +%Y%m%dT%H%M%SZ)"
```

备份写入宿主机 `./backups/<时间戳>/`，包含 `app.db`、`uploads/`（存在时）和 `manifest.json`。

## 恢复预检

恢复前先停止写入。对候选备份运行：

```bash
sqlite3 -readonly backups/<时间戳>/app.db 'PRAGMA integrity_check;'
```

结果必须为 `ok`；核对 `manifest.json` 中的 SHA-256 后，才能在维护窗口替换数据库。

## 故障定位

运行：

```bash
docker compose ps
docker compose logs --tail=100 huoqu
curl --fail http://127.0.0.1:3000/api/health
```

不得把日志中的 Token、密码或密钥复制到工单。
