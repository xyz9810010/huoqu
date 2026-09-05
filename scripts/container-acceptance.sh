#!/usr/bin/env bash
# 容器专项验收（2026-09-05 测试方案 Docker 章节）
# 用法: IMAGE=huoqu:acceptance-20260905 bash scripts/container-acceptance.sh
set -uo pipefail

IMAGE="${IMAGE:-huoqu:acceptance-20260905}"
BASE="${BASE_PORT:-33100}"
ADMIN_PASSWORD="container-acceptance-password"
PUSH_SECRET="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" # 32 字节 Base64
failures=0
tmp_volume="$(mktemp -d -t hq-fa-vol.XXXXXX)"

cleanup() {
  for name in hq-fa-ok hq-fa-baddb hq-fa-nokey hq-fa-limit hq-fa-ro hq-fa-a hq-fa-b; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  case "${tmp_volume}" in
    /tmp/hq-fa-vol.*) rm -rf -- "${tmp_volume}" ;;
    *) printf 'refusing unexpected cleanup path %s\n' "${tmp_volume}" >&2 ;;
  esac
}
trap cleanup EXIT

note() { printf '%-46s' "$1"; }
ok()   { printf '\033[32mok\033[0m  %s\n' "${1:-}"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "${1:-}"; failures=$((failures + 1)); }

health_wait() { # name port
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:${2}/api/health" >/dev/null 2>&1 && return 0
    state="$(docker inspect "$1" --format '{{.State.Status}}' 2>/dev/null || true)"
    [[ "$state" == "exited" || "$state" == "dead" ]] && return 1
    sleep 1
  done
  return 1
}

login_token() { # base_url -> token
  curl -sf -X POST "$1/api/login" -H 'content-type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).token)}catch(e){console.log("")}})'
}

echo "== 1) 镜像启动 / 健康检查 / 前端可达 =="
note "docker run 默认配置启动"
docker run -d --name hq-fa-ok --network host \
  -e PORT="${BASE}" -e DB_PATH="/tmp/hq-fa-ok.db" \
  -e INITIAL_ADMIN_PASSWORD="${ADMIN_PASSWORD}" -e DISABLE_PUSH=1 \
  -e PUSH_CONFIG_MASTER_KEY="${PUSH_SECRET}" \
  "${IMAGE}" node server.js >/dev/null 2>&1 || { bad "启动失败"; exit 1; }
health_wait hq-fa-ok "${BASE}" || { docker logs hq-fa-ok | tail -20; bad "health 未就绪"; }
[[ "$(curl -sf "http://127.0.0.1:${BASE}/" | grep -c '<div id="app">' || true)" == "1" ]] || bad "前端入口缺失"
note "默认配置健康+前端可达"; ok

echo "== 2) 错误 DB 路径：报错退出而非静默损坏 =="
blocker="${tmp_volume}/blocker"
: > "${blocker}"
note "DB 目录被同名文件占位(ENOTDIR)"
docker run -d --name hq-fa-baddb --network host -v "${tmp_volume}:/vol" \
  -e PORT="$((BASE + 1))" -e DB_PATH="/vol/blocker/app.db" -e DISABLE_PUSH=1 \
  "${IMAGE}" node server.js >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  state="$(docker inspect hq-fa-baddb --format '{{.State.Status}}' 2>/dev/null || true)"
  [[ "$state" == "exited" || "$state" == "dead" ]] && break
  sleep 1
done
logs="$(docker logs hq-fa-baddb 2>&1 || true)"
if [[ "$state" == "exited" ]]; then ok "容器退出(code=$(docker inspect hq-fa-baddb --format '{{.State.ExitCode}}'))"
else bad "错误 DB 路径仍存活(状态=$state)"; fi
if grep -qE 'ENOTDIR|EEXIST|EACCES|ENOENT|permission denied|No such file|数据库' <<<"${logs}"; then ok "错误信息明确"
else bad "缺少可读错误提示: ${logs:0:160}"; fi

echo "== 3) 推送开启但缺 PUSH_CONFIG_MASTER_KEY：服务可用，登记被明确 503 =="
note "无主密钥容器启动"
docker run -d --name hq-fa-nokey --network host \
  -e PORT="$((BASE + 2))" -e DB_PATH="/tmp/hq-fa-nokey.db" \
  -e INITIAL_ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  "${IMAGE}" node server.js >/dev/null 2>&1 || { bad "启动失败"; }
health_wait hq-fa-nokey "$((BASE + 2))" || { docker logs hq-fa-nokey | tail -20; bad "health 未就绪"; }
note "服务健康（推送未配置不崩）"; ok
tok3="$(login_token "http://127.0.0.1:$((BASE + 2))")"
if [[ -z "$tok3" ]]; then bad "无主密钥场景登录失败"; else
  payload='{"providerCode":"huawei","platform":"harmonyos","token":"dummy-device-token","appVersion":"1.0.0"}'
  resp3="$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$((BASE + 2))/api/v2/push/devices" \
    -H "authorization: Bearer ${tok3}" -H 'content-type: application/json' -d "${payload}")"
  code3="$(sed -n '1p' <<<"${resp3}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).code||"")}catch(e){console.log("")}})')"
  status3="$(tail -n1 <<<"${resp3}")"
  [[ "$status3" == "503" && "$code3" == "PUSH_MASTER_KEY_MISSING" ]] \
    && ok "登记返回 503+PUSH_MASTER_KEY_MISSING" \
    || bad "期望 503/CODE，实际 status=${status3} code=${code3}"
fi

echo "== 4) CPU/内存资源限制下服务可用且不写脏数据 =="
note "cpus=0.2 memory=96m 下单闭环"
docker run -d --name hq-fa-limit --network host --cpus=0.2 --memory=96m \
  -e PORT="$((BASE + 3))" -e DB_PATH="/tmp/hq-fa-limit.db" \
  -e INITIAL_ADMIN_PASSWORD="${ADMIN_PASSWORD}" -e DISABLE_PUSH=1 \
  "${IMAGE}" node server.js >/dev/null 2>&1 || { bad "受限启动失败"; }
health_wait hq-fa-limit "$((BASE + 3))" || { docker logs hq-fa-limit | tail; bad "受限环境 health 未就绪"; }
tok4="$(login_token "http://127.0.0.1:$((BASE + 3))")"
if [[ -z "$tok4" ]]; then bad "受限环境登录失败"; else
  created="$(curl -s -X POST "http://127.0.0.1:$((BASE + 3))/api/tasks" -H "authorization: Bearer ${tok4}" \
    -H 'content-type: application/json' \
    -d '{"customerName":"受限环境客户","address":"义乌市受限路 1 号","items":[{"goodsName":"纸箱","pieces":1}]}')"
  tid="$(node -e "try{console.log(JSON.parse(process.argv[1]).id||'')}catch(e){console.log('')}" "$created")"
  [[ -n "$tid" ]] && ok "下单成功 id=${tid:0:8}" || bad "受限环境下单失败: ${created:0:160}"
fi

echo "== 5) 日志脱敏：密钥与 token 不落日志 =="
note "PUSH_CONFIG_MASTER_KEY 不落日志"
docker logs hq-fa-ok 2>&1 | grep -q "${PUSH_SECRET}" && bad "日志泄漏推送主密钥" || ok
tok5="$(login_token "http://127.0.0.1:${BASE}")"
if [[ -z "$tok5" ]]; then bad "token 获取失败"; else
  note "会话 token 不落日志"
  sleep 1
  docker logs hq-fa-ok 2>&1 | grep -qF "${tok5}" && bad "会话 token 出现在日志" || ok
fi

echo "== 6) 只读数据卷：服务明确报错，不静默运行 =="
ro_dir="${tmp_volume}/readonly"
mkdir -p "${ro_dir}"
chmod 0555 "${ro_dir}"
docker run -d --name hq-fa-ro --network host \
  -v "${ro_dir}:/app/data:ro" -e PORT="$((BASE + 4))" -e DB_PATH="/app/data/app.db" -e DISABLE_PUSH=1 \
  "${IMAGE}" node server.js >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  ro_state="$(docker inspect hq-fa-ro --format '{{.State.Status}}' 2>/dev/null || true)"
  [[ "$ro_state" == "exited" || "$ro_state" == "dead" ]] && break
  sleep 1
done
ro_logs="$(docker logs hq-fa-ro 2>&1 || true)"
if [[ "$ro_state" == "exited" ]]; then ok "只读卷容器退出"; else bad "只读卷容器仍存活($ro_state)"; fi
if grep -qE 'EACCES|read-only|permission denied|SQLITE_CANTOPEN|只读' <<<"${ro_logs}"; then ok "只读错误提示明确"
else bad "只读提示缺失: ${ro_logs:0:160}"; fi

echo "== 7) 双容器共享同一 SQLite 卷（多实例边界验证） =="
note "同卷读写：WAL 下双实例可串行工作"
docker run -d --name hq-fa-a --network host -v "${tmp_volume}:/dbdata" \
  -e PORT="$((BASE + 5))" -e DB_PATH="/dbdata/shared.db" \
  -e INITIAL_ADMIN_PASSWORD="${ADMIN_PASSWORD}" -e DISABLE_PUSH=1 \
  "${IMAGE}" node server.js >/dev/null 2>&1 || true
sleep 1
docker run -d --name hq-fa-b --network host -v "${tmp_volume}:/dbdata" \
  -e PORT="$((BASE + 6))" -e DB_PATH="/dbdata/shared.db" \
  -e INITIAL_ADMIN_PASSWORD="${ADMIN_PASSWORD}" -e DISABLE_PUSH=1 \
  "${IMAGE}" node server.js >/dev/null 2>&1 || true
health_wait hq-fa-a "$((BASE + 5))" || bad "实例A 未就绪"
health_wait hq-fa-b "$((BASE + 6))" || bad "实例B 未就绪"
ta="$(login_token "http://127.0.0.1:$((BASE + 5))")"
tb="$(login_token "http://127.0.0.1:$((BASE + 6))")"
if [[ -z "$ta" || -z "$tb" ]]; then bad "双实例登录失败"; else
  shared_created="$(curl -s -X POST "http://127.0.0.1:$((BASE + 5))/api/tasks" -H "authorization: Bearer ${ta}" \
    -H 'content-type: application/json' \
    -d '{"customerName":"多实例客户A","address":"义乌市双实例路","items":[{"goodsName":"箱","pieces":1}]}')"
  if node -e "const j=JSON.parse(process.argv[1]); if(!j.id){console.error(j.error||'');process.exit(1)}" "$shared_created" 2>/dev/null; then
    ok "实例A 写入成功"
  else
    shared_err="$(node -e "try{console.log(JSON.parse(process.argv[1]).error||process.argv[1].slice(0,120))}catch(e){console.log(process.argv[1].slice(0,120))}" "$shared_created")"
    bad "实例A 写入异常: ${shared_err:0:120}"
  fi
  read_a="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$((BASE + 6))/api/tasks?page=0&size=5" -H "authorization: Bearer ${tb}")"
  [[ "$read_a" == "200" ]] && ok "实例B 可读(A 写入后)" || bad "实例B 读取异常 status=${read_a}"
fi

if [[ "$failures" -gt 0 ]]; then
  printf 'container-acceptance=FAIL (%s)\n' "$failures"
  exit 1
fi
printf '%s\n' 'container-acceptance=ok'
