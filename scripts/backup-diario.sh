#!/usr/bin/env bash
#
# Backup diário do ADVOC.ME — banco + o que é preciso para reconstruir o sistema.
#
# ────────────────────────────────────────────────────────────────────────────
# POR QUE ESTE SCRIPT EXISTE NESTA FORMA
# ────────────────────────────────────────────────────────────────────────────
# A versão anterior (agosto/2026) já fazia o essencial: dump diário, escrita
# atômica, expurgo. O que ela NÃO fazia é o que separa "tenho backup" de "tenho
# como voltar ao ar":
#
#   1. O backup morava no MESMO disco da produção. Isso protege do DELETE sem
#      WHERE e da migração que deu errado — e de mais nada. Não protege da
#      perda da VPS, que é justamente o desastre que faz alguém procurar o
#      backup. Era cópia 1 de 1.
#   2. Salvava só o banco. Restaurar o banco num servidor novo devolve os dados
#      e um sistema que não sobe: falta o .env (DATABASE_URL, os dois segredos
#      de sessão, as chaves da cadeia de IA), falta o nginx, falta o pm2.
#   3. Saía em texto puro. O dump tem nome, e-mail, OAB, endereço, telefone,
#      FOTO e hash de senha de advogada — dado pessoal sob LGPD. Um arquivo
#      desses não atravessa a internet nem descansa em servidor de terceiro sem
#      estar cifrado.
#   4. Falhava em silêncio. O modo de falha perigoso não é o backup que quebra
#      com erro na tela: é o cron que parou em março e só foi notado em agosto,
#      no dia em que o backup era necessário.
#
# ────────────────────────────────────────────────────────────────────────────
# ONDE ESTÃO OS DADOS DAS ADVOGADAS (levantado em 04/09/2026)
# ────────────────────────────────────────────────────────────────────────────
# TODOS no Postgres. O projeto não grava um único arquivo em disco: não há
# multer, writeFile nem pasta de uploads em todo o src/. A foto é um data URI
# na coluna Profile.avatarUrl; o vídeo é só um link do YouTube/Vimeo; o cartão
# de visita é JSON de escolhas, desenhado na hora pelo cardArt.ts.
#
# Isso é o que torna este backup simples e confiável: pg_dump não é PARTE do
# backup dos dados — é o backup dos dados, inteiro. Se um dia entrar upload de
# arquivo de verdade, ESTE COMENTÁRIO DEIXA DE VALER e a pasta nova precisa
# entrar no pacote da parte 2.
#
# ────────────────────────────────────────────────────────────────────────────
# INSTALAR (uma vez, como root na VPS de produção)
# ────────────────────────────────────────────────────────────────────────────
#   install -m 755 backup-diario.sh /usr/local/bin/advocme-backup
#   mkdir -p /etc/advocme-backup && chmod 700 /etc/advocme-backup
#   # a chave PÚBLICA GPG (a privada fica no PC do dono, nunca aqui):
#   gpg --import /etc/advocme-backup/publica.asc
#   # a configuração, com os endereços e a URL de alerta (0600, fora do git):
#   vi /etc/advocme-backup/backup.conf
#   crontab -e
#     15 3 * * * /usr/local/bin/advocme-backup >> /var/log/advocme-backup.log 2>&1
#
# Procedimento completo de restauração: backend/docs/recuperacao-de-desastre.md

set -euo pipefail

# ── Configuração ────────────────────────────────────────────────────────────
# NADA de segredo neste arquivo: ele é versionado no git. Endereços, chaves e a
# URL de alerta vivem em backup.conf (0600), que não entra em repositório
# nenhum. Mesma regra do .env.
CONF="${ADVOCME_BACKUP_CONF:-/etc/advocme-backup/backup.conf}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

DESTINO_LOCAL="${ADVOCME_BACKUP_DIR:-/root/backups}"
MANTER_DIAS="${ADVOCME_BACKUP_KEEP:-14}"
ENV_APP="${ADVOCME_ENV:-/root/advocme-backend/.env}"
APP_DIR="${ADVOCME_APP_DIR:-/root/advocme-backend}"
GPG_DESTINATARIO="${ADVOCME_GPG_ID:-backup@advoc.me}"
OFFSITE_SSH="${ADVOCME_OFFSITE_SSH:-}"          # ex.: root@<ip> (vem do backup.conf)
OFFSITE_KEY="${ADVOCME_OFFSITE_KEY:-/root/.ssh/advocme_backup_offsite}"
HC_URL="${ADVOCME_HC_URL:-}"                     # ping de monitoramento (opcional)

MOMENTO="$(date +%F)"
RELATORIO="$(mktemp)"
# Declaradas aqui porque o trap de saída olha para elas mesmo se a execução
# morrer antes de chegar na parte que as usa (set -u não perdoa não-declarada).
TEMP=""; PACOTE=""; CIFRADO=""

anota() { echo "[$(date -Is)] $*" | tee -a "$RELATORIO"; }

# ── Monitoramento ───────────────────────────────────────────────────────────
# Um ping HTTP por execução. O que sai daqui é o UUID do check e as linhas de
# log abaixo — nomes de arquivo, tamanhos e contagens. NUNCA o conteúdo do
# backup, nunca uma credencial.
#
# O ganho não é o aviso de erro (esse o log local já daria): é o serviço avisar
# quando o ping NÃO CHEGA. Cron desligado, VPS fora do ar e disco cheio são
# falhas mudas — só um observador de fora percebe a ausência.
ping_monitor() {
  [ -n "$HC_URL" ] || return 0
  local sufixo="$1"
  curl -fsS -m 15 --retry 3 --data-binary "@$RELATORIO" \
       "${HC_URL}${sufixo}" >/dev/null 2>&1 || true
}

# Qualquer saída que não seja o exit 0 do fim vira alerta. Inclui erro de
# comando (set -e), disco cheio no meio do dump e o servidor sendo reiniciado.
#
# UM trap só, do começo ao fim, e ele é a PRIMEIRA coisa a rodar na saída.
# A versão anterior usava traps compostos para limpar cada temporário
# (trap 'rm -f "$TEMP"; falhou' EXIT) e isso tinha um defeito grave: o `rm`
# rodava antes e ZERAVA o $?, então `falhou` via código 0 e não alertava. Uma
# falha no dump, no empacotamento ou no envio — justamente as prováveis — saía
# calada. Aqui o código é capturado na primeira linha e a limpeza vem depois.
falhou() {
  local codigo=$?
  if [ -n "${TEMP:-}" ];    then rm -f  "$TEMP";    fi
  if [ -n "${CIFRADO:-}" ]; then rm -f  "$CIFRADO"; fi
  if [ -n "${PACOTE:-}" ];  then rm -rf "$PACOTE";  fi
  if [ "$codigo" -ne 0 ]; then
    anota "FALHA: o backup terminou com código $codigo"
    ping_monitor "/fail"
  fi
  rm -f "$RELATORIO"
}
trap falhou EXIT

ping_monitor "/start"

# ── A URL do banco sai do .env da aplicação ─────────────────────────────────
# Um lugar só para o segredo, em vez de uma segunda cópia dentro do cron que
# ninguém lembra de atualizar quando a senha do Postgres muda.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_APP" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_APP" | head -1 | cut -d= -f2- | tr -d "\"'")"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  anota "ERRO: DATABASE_URL não encontrada (nem no ambiente, nem em $ENV_APP)"
  exit 1
fi

# ════════════════════════════════════════════════════════════════════════════
# PARTE 1 — cópia LOCAL, em texto claro (a que se usa no dia a dia)
# ════════════════════════════════════════════════════════════════════════════
# Fica sem cifra de propósito: é a cópia de conveniência, para desfazer o erro
# de terça-feira sem procurar chave nenhuma. Vive em /root (0700), num disco que
# só o root alcança. A cópia que SAI da máquina é a cifrada, na parte 3.
mkdir -p "$DESTINO_LOCAL"
chmod 700 "$DESTINO_LOCAL"
DUMP="$DESTINO_LOCAL/advocme-diario-$MOMENTO.sql.gz"
TEMP="$DUMP.parcial"

# Grava num temporário e só então renomeia. Sem isso, um dump interrompido no
# meio (disco cheio, servidor reiniciado) deixaria um .sql.gz truncado com o
# nome do dia — um arquivo que PARECE um backup e não é. É a pior falha
# possível aqui, porque só aparece no dia da restauração.
pg_dump --no-owner --no-acl "$DATABASE_URL" | gzip -9 > "$TEMP"
gunzip -t "$TEMP"          # o gzip fechou íntegro?
mv "$TEMP" "$DUMP"
chmod 600 "$DUMP"
TEMP=""

anota "dump local ok: $DUMP ($(du -h "$DUMP" | cut -f1))"

# ════════════════════════════════════════════════════════════════════════════
# PARTE 2 — o pacote de RECONSTRUÇÃO
# ════════════════════════════════════════════════════════════════════════════
# Só o que não se refaz sozinho. dist/ e node_modules/ ficam de fora: são
# reconstruíveis do git em dois comandos, e copiá-los transformaria um pacote de
# 100 KB num de 300 MB — o backup que é grande demais é o backup que ninguém
# guarda por 30 dias.
PACOTE="$(mktemp -d)"

cp "$DUMP" "$PACOTE/banco-advocme.sql.gz"

# O .env é o que separa "recuperei os dados" de "voltei ao ar". Sem ele não há
# DATABASE_URL, não há AUTH_SESSION_SECRET (trocá-lo desloga todo mundo) e não
# há a cadeia de chaves de IA. É por causa dele que este pacote é cifrado.
[ -f "$ENV_APP" ]                  && cp "$ENV_APP" "$PACOTE/env-producao.txt"
[ -f "$APP_DIR/.bi-credenciais" ]  && cp "$APP_DIR/.bi-credenciais" "$PACOTE/bi-credenciais.txt"
# O formato exato do banco NAQUELE dia — é o que deixa conferir se o dump velho
# combina com o código que se está tentando subir.
[ -f "$APP_DIR/prisma/schema.prisma" ] && cp "$APP_DIR/prisma/schema.prisma" "$PACOTE/schema.prisma"
[ -f /etc/nginx/sites-available/advocme-api ] && cp /etc/nginx/sites-available/advocme-api "$PACOTE/nginx-advocme-api.conf"
[ -f /root/.pm2/dump.pm2 ]         && cp /root/.pm2/dump.pm2 "$PACOTE/pm2-dump.json"
crontab -l > "$PACOTE/crontab-root.txt" 2>/dev/null || true

# ── Manifesto ───────────────────────────────────────────────────────────────
# Serve para conferir um backup SEM restaurá-lo. A contagem por tabela responde
# a pergunta que importa na hora do desastre — "tem gente dentro deste arquivo,
# ou eu venho salvando um banco vazio há três semanas?" — e as versões dizem
# contra o que este dump foi feito, que é o que impede tentar restaurar um dump
# do Postgres 16 num servidor novo com o 15.
{
  echo "# Backup ADVOC.ME — $(date -Is)"
  echo
  echo "Origem      : $(hostname) $(hostname -I | awk '{print $1}')"
  echo "Node        : $(node -v 2>/dev/null || echo '?')"
  echo "PostgreSQL  : $(pg_dump --version | awk '{print $3}')"
  echo "pm2         : $(pm2 -v 2>/dev/null || echo '?')"
  echo "Dump        : $(stat -c%s "$DUMP") bytes"
  echo "sha256 dump : $(sha256sum "$DUMP" | cut -d' ' -f1)"
  echo
  echo "## Linhas por tabela no momento do dump"
  psql "$DATABASE_URL" -Atc "select relname||' = '||n_live_tup from pg_stat_user_tables where n_live_tup>0 order by n_live_tup desc" 2>/dev/null || echo "(não foi possível consultar)"
  echo
  echo "## Como restaurar"
  echo "Ver backend/docs/recuperacao-de-desastre.md (procedimento completo e testado)."
} > "$PACOTE/MANIFESTO.txt"

# ── Cifra ───────────────────────────────────────────────────────────────────
# ASSIMÉTRICA de propósito: esta VPS tem só a chave PÚBLICA. Ela consegue fechar
# o pacote e não consegue abrir nenhum — nem os que ela mesma mandou ontem. Quem
# invadir a produção leva os dados vivos (não há como evitar), mas não ganha o
# histórico junto. A chave privada nunca esteve neste servidor.
CIFRADO="$(mktemp)"
tar -C "$PACOTE" -czf - . \
  | gpg --batch --yes --trust-model always --encrypt \
        --recipient "$GPG_DESTINATARIO" --output "$CIFRADO"
anota "pacote cifrado: $(du -h "$CIFRADO" | cut -f1) ($(ls "$PACOTE" | tr '\n' ' '))"

# ════════════════════════════════════════════════════════════════════════════
# PARTE 3 — cópia FORA da máquina
# ════════════════════════════════════════════════════════════════════════════
# Vai por stdin para um comando forçado no destino (advocme-receber). Esta chave
# não abre shell, não lista e não apaga: no destino ela consegue UMA coisa,
# acrescentar o arquivo de hoje. É o que faz o histórico sobreviver a um
# ransomware que domine esta VPS — ele tem a chave e mesmo assim não alcança as
# cópias de ontem.
if [ -n "$OFFSITE_SSH" ]; then
  COMPROVANTE="$(ssh -T -o BatchMode=yes -o ConnectTimeout=30 -i "$OFFSITE_KEY" "$OFFSITE_SSH" < "$CIFRADO")"
  anota "offsite ok: $COMPROVANTE"
else
  anota "AVISO: sem destino offsite configurado (ADVOCME_OFFSITE_SSH vazio) — só há cópia local"
fi
rm -f "$CIFRADO"; CIFRADO=""
rm -rf "$PACOTE"; PACOTE=""

# ── Expurgo local ───────────────────────────────────────────────────────────
# Roda DEPOIS de tudo ter dado certo. Apagar as antigas antes deixaria uma
# janela sem nenhum backup válido. (A retenção do destino remoto é decidida LÁ,
# pelo receptor — esta máquina não manda em quanto tempo o histórico dura.)
find "$DESTINO_LOCAL" -name 'advocme-diario-*.sql.gz' -type f -mtime "+$MANTER_DIAS" -print -delete

anota "concluído"
ping_monitor ""
trap - EXIT
rm -f "$RELATORIO"
exit 0
