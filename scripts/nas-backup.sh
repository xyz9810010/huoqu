#!/usr/bin/env bash
set -euo pipefail

stamp="${1:?backup stamp required}"
backup="/vol1/cargo-pickup-backups/${stamp}"
db_backup="/app/data/app-db-backup-${stamp}.sqlite"

mkdir -p "${backup}/staging-data"
docker exec cargo-pickup-stats node -e "const D=require('better-sqlite3');const d=new D('/app/data/app.db');d.backup('${db_backup}').then(function(){d.close();console.log('backup-ok')}).catch(function(e){console.error(e);process.exit(1)})"
cp "/vol1/cargo-pickup/data/app-db-backup-${stamp}.sqlite" "${backup}/app.db"
cp "/vol1/cargo-pickup/data/app-db-backup-${stamp}.sqlite" "${backup}/staging-data/app.db"
if [[ -d /vol1/cargo-pickup/data/uploads ]]; then
  cp -a /vol1/cargo-pickup/data/uploads "${backup}/"
  cp -a /vol1/cargo-pickup/data/uploads "${backup}/staging-data/"
fi
tar -czf "${backup}/source-before.tgz" --exclude=data -C /vol1/cargo-pickup .
docker inspect cargo-pickup-stats > "${backup}/container-inspect.json"
docker image inspect cargo-pickup-cargo-pickup > "${backup}/image-inspect.json"
sha256sum "${backup}/app.db" "${backup}/source-before.tgz" > "${backup}/SHA256SUMS"
printf '%s\n' 'old_image=sha256:3256e0ac510073d3549bb98d8787e0646e7ae9daa28ca86f679f706a23b890db' > "${backup}/ROLLBACK.txt"
ls -lh "${backup}"
cat "${backup}/SHA256SUMS"
