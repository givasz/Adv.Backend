#!/usr/bin/env bash
#
# Backup diário do Postgres da VPS.
#
# Até agora só havia dump MANUAL, feito antes de cada deploy com schema
# destrutivo (ver DEPLOY-VPS.md). Isso protege contra a migração que dá errado —
# e contra mais nada. Não protege do disco que falha, do `DELETE` sem `WHERE`, do
# ransomware, nem do simples "alguém apagou o perfil errado na terça e só notou
# na sexta". Para esses, o que vale é a cópia de ONTEM, que ninguém lembra de
# fazer no dia em que precisa dela.
#
# INSTALAR (uma vez, como root na VPS):
#
#   install -m 755 backup-diario.sh /usr/local/bin/advocme-backup
#   mkdir -p /root/backups
#   crontab -e
#     # backup do advoc.me, todo dia às 03h15
#     15 3 * * * /usr/local/bin/advocme-backup >> /var/log/advocme-backup.log 2>&1
#
# CONFERIR que funcionou (faça isto no dia seguinte — um backup nunca testado
# não é um backup):
#
#   ls -lh /root/backups/
#   gunzip -t /root/backups/advocme-diario-*.sql.gz   # o arquivo abre?
#
# RESTAURAR:
#
#   gunzip -c /root/backups/advocme-diario-AAAA-MM-DD.sql.gz | psql "$DATABASE_URL"

set -euo pipefail

DESTINO="${ADVOCME_BACKUP_DIR:-/root/backups}"
# Quantas cópias diárias ficam. 14 cobre "só notei na semana seguinte" e cabe
# folgado no disco: o dump comprimido deste banco é de alguns megabytes.
MANTER_DIAS="${ADVOCME_BACKUP_KEEP:-14}"

# A URL do banco sai do .env da aplicação — um lugar só para o segredo, em vez de
# uma segunda cópia dentro do cron que ninguém lembra de atualizar.
ENV_APP="${ADVOCME_ENV:-/root/advocme/backend/.env}"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_APP" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_APP" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[$(date -Is)] ERRO: DATABASE_URL não encontrada (nem no ambiente, nem em $ENV_APP)" >&2
  exit 1
fi

mkdir -p "$DESTINO"
ARQUIVO="$DESTINO/advocme-diario-$(date +%F).sql.gz"

# Grava num arquivo temporário e só então renomeia. Sem isso, um dump
# interrompido no meio (disco cheio, servidor reiniciado) deixaria um .sql.gz
# truncado com o nome do dia — um arquivo que PARECE um backup e não é. É a pior
# falha possível aqui, porque ela só aparece no dia da restauração.
TEMP="$ARQUIVO.parcial"
trap 'rm -f "$TEMP"' EXIT

pg_dump --no-owner --no-acl "$DATABASE_URL" | gzip -9 > "$TEMP"

# Confere que o gzip fechou íntegro antes de aceitar o arquivo como bom.
gunzip -t "$TEMP"
mv "$TEMP" "$ARQUIVO"
trap - EXIT

echo "[$(date -Is)] backup ok: $ARQUIVO ($(du -h "$ARQUIVO" | cut -f1))"

# Expurgo das cópias antigas. Roda DEPOIS do dump novo ter dado certo: apagar as
# antigas antes deixaria uma janela sem nenhum backup válido.
find "$DESTINO" -name 'advocme-diario-*.sql.gz' -type f -mtime "+$MANTER_DIAS" -print -delete
