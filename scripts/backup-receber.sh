#!/usr/bin/env bash
#
# Receptor de backup do ADVOC.ME — roda NA VPS DE BACKUP, como comando
# forçado da chave "advocme-backup-offsite" no authorized_keys do root.
#
# POR QUE UM COMANDO FORÇADO, E NÃO UM scp NORMAL:
# A VPS de produção precisa entrar aqui todo dia para depositar o backup. Se a
# chave dela desse um shell, ou mesmo um scp comum, quem invadisse a produção
# entraria aqui e apagaria o histórico inteiro — que é exatamente o que um
# ransomware faz antes de cifrar. Com este comando forçado, a chave da produção
# consegue UMA coisa só: acrescentar o arquivo de hoje. Ela não lista, não lê,
# não apaga e não alcança mais nada desta máquina — que hospeda outro projeto.
#
# O nome do arquivo é decidido AQUI, pela data DESTE servidor. O remetente não
# escolhe caminho nem nome — não há como escrever fora de $DESTINO.
#
# Instalado por: implantação do backup automático (2026-09-04).
# Documentação: backend/docs/recuperacao-de-desastre.md

set -euo pipefail

DESTINO=/var/backups/advocme
LOG=/var/log/advocme-offsite.log
# Abaixo disto o arquivo não pode ser um backup de verdade — é stream cortado,
# disco cheio na origem ou pipe que morreu no meio. Aceitar um arquivo desses
# significaria substituir o backup de hoje por lixo e só descobrir na hora do
# desastre.
MINIMO_BYTES=1024
MANTER_DIARIOS=30    # dias corridos de cópias diárias
MANTER_MENSAIS=12    # meses de cópias do dia 1º (mantidas além dos diários)

registrar() { echo "[$(date -Is)] $*" >> "$LOG"; }

mkdir -p "$DESTINO"
chmod 700 "$DESTINO"

ARQUIVO="$DESTINO/advocme-$(date +%F).tar.gpg"
TEMP="$(mktemp "$DESTINO/.recebendo.XXXXXX")"
trap 'rm -f "$TEMP"' EXIT

cat > "$TEMP"

TAM=$(stat -c%s "$TEMP")
if [ "$TAM" -lt "$MINIMO_BYTES" ]; then
  registrar "RECUSADO: recebi $TAM bytes (mínimo $MINIMO_BYTES). Backup de hoje NÃO foi substituído."
  echo "RECUSADO: $TAM bytes é pequeno demais para ser um backup" >&2
  exit 1
fi

# O arquivo chega cifrado com GPG. Conferir o cabeçalho custa nada e barra o
# caso em que a origem mandou uma mensagem de erro em texto no lugar do backup.
#
# O teste é o invariante do formato, não uma lista de bytes: TODO pacote OpenPGP
# começa com um byte de tag que tem o bit mais alto ligado (>= 128). Texto ASCII
# nunca tem. A primeira versão desta linha procurava valores específicos de tag
# e alertava à toa — o pacote real vem com 132 (PKESK, formato antigo), que não
# estava na lista.
PRIMEIRO=$(head -c 1 "$TEMP" | od -An -tu1 | tr -d ' ')
if [ "${PRIMEIRO:-0}" -lt 128 ]; then
  registrar "RECUSADO: não parece arquivo OpenPGP (primeiro byte $PRIMEIRO). Backup de hoje NÃO foi substituído."
  echo "RECUSADO: conteúdo não é um pacote OpenPGP" >&2
  exit 1
fi

SOMA=$(sha256sum "$TEMP" | cut -d' ' -f1)
chmod 600 "$TEMP"
mv "$TEMP" "$ARQUIVO"
trap - EXIT

registrar "recebido: $(basename "$ARQUIVO") $TAM bytes sha256=$SOMA"

# ---- Expurgo. Roda DEPOIS de o arquivo novo estar salvo: apagar antes deixaria
# uma janela sem cópia nenhuma. ----
LIMITE_DIARIO=$(date -d "-$MANTER_DIARIOS days" +%F)
LIMITE_MENSAL=$(date -d "-$MANTER_MENSAIS months" +%F)

for f in "$DESTINO"/advocme-*.tar.gpg; do
  [ -e "$f" ] || continue
  DIA=$(basename "$f" | sed -E 's/^advocme-([0-9]{4}-[0-9]{2}-[0-9]{2})\.tar\.gpg$/\1/')
  [ "$DIA" != "$(basename "$f")" ] || continue        # nome fora do padrão: não toco
  [[ "$DIA" > "$LIMITE_DIARIO" ]] && continue          # dentro dos 30 dias: fica
  if [[ "$DIA" == *-01 ]] && [[ "$DIA" > "$LIMITE_MENSAL" ]]; then
    continue                                           # cópia do dia 1º dentro de 12 meses: fica
  fi
  rm -f "$f" && registrar "expurgado: $(basename "$f")"
done

# Devolve o comprovante para a produção registrar no log dela. É só isto que a
# chave da produção consegue LER daqui.
echo "OK $(basename "$ARQUIVO") $TAM $SOMA"
