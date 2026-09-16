#!/usr/bin/env bash
# 生成自签证书，供 HTTPS 反代使用（详见 compose.https.yaml / deploy/Caddyfile）。
#
# 为什么需要：摄像头 API（getUserMedia）只在"安全上下文"存在，而浏览器把
# http://<内网IP> 视为非安全上下文（实测 navigator.mediaDevices 直接不存在）。
# 想让「对准就自动识别」的实时扫码可用，就必须走 HTTPS。
# 但内网环境通常既访问不到 Let's Encrypt，80/443 也可能被占用，因此提供自签方案。
#
# 用法：
#   bash scripts/gen-self-signed-cert.sh [IP或域名] [有效天数]
# 例：
#   bash scripts/gen-self-signed-cert.sh 192.168.5.83 3650
#
# 产物：secrets/tls/cert.pem、secrets/tls/key.pem（secrets/ 已被 .gitignore 忽略）
#
# 注意：自签证书不被设备信任，浏览器首次访问会提示"不安全"，需手动选择继续。
# 若希望没有提示，需要把本脚本产出的 CA 或证书安装到每台设备（见 README 说明）。
set -euo pipefail

HOST="${1:-192.168.5.83}"
DAYS="${2:-3650}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/secrets/tls"
mkdir -p "$OUT"

# SAN 里同时写入该地址与 localhost，便于同一份证书在服务器本机自测
cat > "$OUT/san.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = $HOST

[v3_req]
subjectAltName = @alt
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
IP.1 = $HOST
IP.2 = 127.0.0.1
DNS.1 = localhost
CNF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -days "$DAYS" -config "$OUT/san.cnf" 2>/dev/null

chmod 600 "$OUT/key.pem"
chmod 644 "$OUT/cert.pem"

echo "已生成自签证书（$DAYS 天）："
echo "  证书: $OUT/cert.pem"
echo "  私钥: $OUT/key.pem"
openssl x509 -in "$OUT/cert.pem" -noout -subject -dates -ext subjectAltName | sed 's/^/  /'
