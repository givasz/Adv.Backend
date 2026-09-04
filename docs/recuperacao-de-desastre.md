# Recuperação de desastre — ADVOC.ME

_Implantado e testado em 04/09/2026._

Este documento vive **no git** de propósito. Um manual de desastre guardado só
no PC de quem faz o deploy é inútil no dia em que o desastre alcança esse PC.
Aqui está o procedimento; os segredos ficam em `~/.advocme-secrets/` e são
apontados pelo nome, nunca escritos.

> **Antes de rodar qualquer comando daqui**, defina o endereço da VPS de backup
> — ele não é escrito neste arquivo porque o repositório é público, e dizer em
> praça pública onde moram os backups é entregar o segundo alvo junto com o
> primeiro:
>
> ```bash
> export BKP=<ip da VPS de backup>          # ambos estão em
> export BKPKEY=~/.ssh/<chave da VPS de backup>   # ~/.advocme-secrets/backup-destino.txt
> ```

---

## O essencial, em cinco linhas

- **Todos os dados das advogadas estão no PostgreSQL.** Não há pasta de uploads.
- Backup **diário às 03h15 UTC** (00h15 em Brasília), automático.
- **Três cópias:** banco vivo → `/root/backups` (produção) → VPS de backup, fora da máquina (cifrado).
- Guarda: **14 dias** na produção, **30 dias + 12 meses** fora dela.
- Para abrir um backup off-site você precisa de **`advocme-backup-PRIVADA.asc`**.
  Sem essa chave, nenhum backup remoto abre. Nunca.

---

## 1. Onde estão os dados — e por que o backup é tão pequeno

Levantamento de 04/09/2026: o projeto **não grava um único arquivo em disco**.
Não existe `multer`, `writeFile` nem pasta de uploads em todo o `src/`.

| O que parece arquivo | Onde realmente está |
|---|---|
| Foto do perfil | Data URI na coluna `Profile.avatarUrl`, dentro do Postgres |
| Vídeo de apresentação | Só o **link** do YouTube/Vimeo (`Profile.videoUrl`) |
| Cartão de visita impresso | JSON de escolhas (`Profile.card`); o desenho é feito na hora pelo `cardArt.ts` |
| Logo do escritório | Coluna `Firm.logoUrl` |
| Documentos de terceiros | **Não existem.** A agenda nativa foi removida em 21/08/2026 justamente para não guardar dado de visitante |

Por isso `pg_dump` não é *parte* do backup: **é o backup dos dados, inteiro.**
O dump comprimido tem ~96 KB e o pacote cifrado ~112 KB.

> ⚠️ **Se um dia entrar upload de arquivo de verdade** (petição, contrato,
> documento enviado pela advogada), esta seção deixa de valer e a pasta nova
> precisa entrar no pacote da PARTE 2 do `backend/scripts/backup-diario.sh`.

---

## 2. Arquitetura

```
   VPS PRODUÇÃO — 74.208.118.111
   ┌────────────────────────────────────────────┐
   │ PostgreSQL 16 · banco "advocme" (127.0.0.1)│  cópia 1 — dados vivos
   │        │                                   │
   │        │ pg_dump --no-owner --no-acl        │
   │        ▼                                   │
   │ /root/backups/advocme-diario-AAAA-MM-DD.sql.gz │ cópia 2 — local, texto claro,
   │        │                                   │            14 dias, uso diário
   │        │ + .env + schema + nginx + pm2      │
   │        │ + MANIFESTO → tar → GPG (pública)  │
   └────────┼───────────────────────────────────┘
            │  ssh -T (chave advocme_backup_offsite)
            │  comando forçado no destino: não dá shell, não lê, não apaga
            ▼
   VPS DE BACKUP (endereço: ver ~/.advocme-secrets/)
   /var/backups/advocme/advocme-AAAA-MM-DD.tar.gpg   cópia 3 — off-site, cifrada,
                                                     30 dias + 12 mensais
```

### Por que a chave de envio é travada

No `authorized_keys` da VPS de backup a chave da produção está presa assim:

```
command="/usr/local/bin/advocme-receber",restrict,from="74.208.118.111" ssh-ed25519 AAAA... advocme-backup-offsite
```

Ela consegue **uma** coisa: acrescentar o arquivo de hoje. Não abre shell, não
lista, não lê e não apaga. Isso importa no cenário que realmente destrói
empresas: quem domina a produção tem a chave — e, mesmo assim, **não alcança o
histórico de backups** para apagá-lo antes de pedir resgate.

Testado em 04/09/2026: um `cat /root/.ssh/authorized_keys` enviado por essa
chave foi simplesmente ignorado; o receptor rodou no lugar dele.

### Por que a cifra é assimétrica

A produção tem só a **chave pública**. Ela fecha o pacote e **não consegue abrir
nenhum** — nem os que ela mesma mandou ontem (`gpg --list-secret-keys` lá
responde "No secret key"). A chave privada nunca esteve em servidor algum.

A cópia local em `/root/backups` fica **sem cifra** de propósito: é a de
conveniência, para desfazer o erro de terça sem procurar chave nenhuma. Ela vive
em `/root` (0700), num disco que só o root alcança, e nunca sai da máquina.

---

## 3. Arquivos e onde cada coisa mora

### Na VPS de produção (74.208.118.111)

| Caminho | O que é | Permissão |
|---|---|---|
| `/usr/local/bin/advocme-backup` | O script. Fonte versionado: `backend/scripts/backup-diario.sh` | 755 |
| `/etc/advocme-backup/backup.conf` | Endereços, caminhos e a URL de alerta. **Não vai para o git** | 600 |
| `/etc/advocme-backup/publica.asc` | Chave GPG **pública** | 644 |
| `/root/.ssh/advocme_backup_offsite` | Chave SSH de envio (só serve para depositar backup) | 600 |
| `/root/backups/` | Cópias diárias locais, texto claro | 700 (arquivos 600) |
| `/var/log/advocme-backup.log` | Log das execuções (rotaciona mensal, guarda 12) | 600 |
| `/root/advocme-backup.v1-2026-09-04.bak` | O script antigo, preservado | 644 |

### Na VPS de backup

| Caminho | O que é | Permissão |
|---|---|---|
| `/usr/local/bin/advocme-receber` | Receptor. Fonte versionado: `backend/scripts/backup-receber.sh` | 755 |
| `/var/backups/advocme/` | Os backups cifrados | 700 (arquivos 600) |
| `/var/log/advocme-offsite.log` | Log de recebimento e expurgo | 600 |
| `/root/.ssh/authorized_keys.antes-advocme-2026-09-04` | Cópia do arquivo antes da mudança | 600 |

### No seu PC (`~/.advocme-secrets/`) — **fora de qualquer repositório**

| Arquivo | Para que serve |
|---|---|
| **`advocme-backup-PRIVADA.asc`** | **Abre os backups cifrados. Sem ela nada é recuperável.** |
| `advocme-backup-PUBLICA.asc` | Cópia da pública (reinstalar noutra VPS) |
| `gpg-keyring/` | Chaveiro GPG já montado com as duas |
| `vpskey` | Entrada SSH na VPS de produção |
| `producao.env` | Cópia do `.env` de produção + senhas de root e Postgres |

> 🔴 **`advocme-backup-PRIVADA.asc` não tem senha.** Foi decisão consciente:
> disponibilidade acima de sigilo, porque a prioridade declarada é *não perder os
> dados* e uma senha esquecida transforma todo o histórico em lixo. Consequência:
> **o arquivo é a chave.** Trate-o como a `vpskey` e guarde uma cópia fora do PC
> (pendrive num lugar diferente, cofre de senhas com anexo). Se o PC morrer e essa
> chave for junto, os backups off-site viram bytes ilegíveis para sempre.

---

## 4. Quando roda e quanto se guarda

| | Produção | VPS de backup |
|---|---|---|
| Quando | 03h15 UTC (00h15 Brasília), cron do root | Chega junto, no mesmo minuto |
| Formato | `.sql.gz` texto claro | `.tar.gpg` cifrado |
| Retenção | 14 dias | 30 dias + o dia 1º de cada mês, por 12 meses |
| Tamanho hoje | ~96 KB por dia | ~112 KB por dia |
| Espaço em 1 ano | ~1,4 MB | ~5 MB |

Quem decide a retenção remota é o **destino**, não a origem — a produção não tem
como encurtar o histórico nem por engano nem por invasão.

Testado em 04/09/2026 com arquivos datados: dos 6 casos (dentro de 30 dias, dia
1º dentro de 12 meses, dia 1º além de 12 meses, dia comum além de 30 dias), todos
os 6 se comportaram como especificado.

**Custo mensal: R$ 0,00.** As duas VPS já são pagas e o volume é irrisório.

---

## 5. Como saber se o último backup funcionou

### O jeito rápido (10 segundos)

```bash
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 "tail -5 /var/log/advocme-backup.log"
```

Uma execução saudável tem 4 linhas e termina em `concluído`:

```
[...] dump local ok: /root/backups/advocme-diario-2026-09-04.sql.gz (96K)
[...] pacote cifrado: 112K (MANIFESTO.txt banco-advocme.sql.gz ... )
[...] offsite ok: OK advocme-2026-09-04.tar.gpg 114642 38132c0f...
[...] concluído
```

Qualquer linha `FALHA:` significa que a execução morreu — e que a cópia off-site
daquele dia **não existe**, mesmo que a local exista.

### Conferir que o arquivo chegou do outro lado

```bash
ssh -i $BKPKEY root@$BKP "ls -lh /var/backups/advocme/ && tail -5 /var/log/advocme-offsite.log"
```

### Conferir sem restaurar nada (o manifesto)

O pacote traz um `MANIFESTO.txt` com a contagem de linhas por tabela no momento
do dump. É o que responde a pergunta que importa — *"tem gente dentro deste
arquivo, ou eu venho salvando um banco vazio há três semanas?"*:

```bash
scp -i $BKPKEY root@$BKP:/var/backups/advocme/advocme-2026-09-04.tar.gpg .
export GNUPGHOME=~/.advocme-secrets/gpg-keyring
gpg -d advocme-2026-09-04.tar.gpg | tar -xzO ./MANIFESTO.txt
```

### O alerta automático

O script faz um ping HTTP em cada execução (`/start`, sucesso, `/fail`) para o
Healthchecks.io. **O ganho não é o aviso de erro** — esse o log já daria. É o
serviço avisar quando o ping **não chega**: cron desligado, VPS fora do ar e
disco cheio são falhas mudas, e só um observador de fora percebe a ausência.

O que sai da VPS: o UUID do check e as linhas de log acima (nomes de arquivo,
tamanhos, sha256, contagem por tabela). **Nunca** o conteúdo do backup, nunca uma
credencial.

Ligar leva 2 minutos — ver seção 9.

---

## 6. Restaurar o banco

### Caso A — desfazer um estrago de hoje ou desta semana (VPS viva)

A cópia local resolve; não precisa de chave GPG nenhuma.

```bash
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111
ls -lh /root/backups/                      # escolha o dia
gunzip -t /root/backups/advocme-diario-2026-09-03.sql.gz   # o arquivo abre?
```

**Antes de sobrescrever qualquer coisa, tire um dump do estado atual** — mesmo
um banco estragado é a única cópia do que aconteceu depois do último backup:

```bash
DB=$(grep -E '^DATABASE_URL=' /root/advocme-backend/.env | cut -d= -f2- | tr -d '"')
pg_dump --no-owner --no-acl "$DB" | gzip > /root/backups/advocme-ANTES-DA-RESTAURACAO-$(date +%F-%H%M).sql.gz
```

**Ensaie num banco separado** — nunca restaure direto na produção sem ver o
resultado antes:

```bash
sudo -u postgres psql -c "CREATE DATABASE advocme_ensaio OWNER postgres;"
gunzip -c /root/backups/advocme-diario-2026-09-03.sql.gz | sudo -u postgres psql -v ON_ERROR_STOP=1 -d advocme_ensaio
sudo -u postgres psql -d advocme_ensaio -c 'select count(*) from "Profile";'
```

Se estiver certo, aí sim vai para a produção:

```bash
pm2 stop advocme-backend                   # ninguém escrevendo durante a troca
sudo -u postgres psql -c "ALTER DATABASE advocme RENAME TO advocme_ruim_$(date +%Y%m%d);"
sudo -u postgres psql -c "CREATE DATABASE advocme OWNER advocme;"
gunzip -c /root/backups/advocme-diario-2026-09-03.sql.gz | psql -v ON_ERROR_STOP=1 "$DB"
pm2 restart advocme-backend --update-env && pm2 save
pm2 logs advocme-backend --lines 30
sudo -u postgres psql -c "DROP DATABASE advocme_ensaio;"
```

O banco antigo fica **renomeado, não apagado**. Só derrube o `advocme_ruim_*`
depois de dias de sistema no ar.

### Caso B — restaurar a partir do backup off-site (cifrado)

```bash
# 1. trazer
scp -i $BKPKEY root@$BKP:/var/backups/advocme/advocme-2026-09-04.tar.gpg .

# 2. abrir com a chave privada (no SEU PC)
export GNUPGHOME=~/.advocme-secrets/gpg-keyring
mkdir aberto && gpg -d advocme-2026-09-04.tar.gpg | tar -xzf - -C aberto
ls aberto/
#   MANIFESTO.txt  banco-advocme.sql.gz  bi-credenciais.txt  crontab-root.txt
#   env-producao.txt  nginx-advocme-api.conf  pm2-dump.json  schema.prisma

# 3. daí em diante é o Caso A, usando aberto/banco-advocme.sql.gz
```

---

## 7. Restaurar "uploads" e documentos

**Não há o que restaurar em separado.** As fotos são data URIs dentro da tabela
`Profile`: restaurou o banco, voltaram as fotos.

Conferir que uma foto voltou de verdade (extrai e testa como imagem):

```bash
psql "$DB" -Atc "select \"avatarUrl\" from \"Profile\" where slug='geyse-camila-mattos'" \
  | sed -E 's#^data:image/[a-zA-Z0-9+.-]+;base64,##' | tr -d '\n' | base64 -d > /tmp/foto.jpg
file -b /tmp/foto.jpg     # esperado: JPEG image data ... 512x512
```

---

## 8. A VPS de produção foi perdida por completo

Ordem dos fatos: **primeiro os dados voltam, depois o site volta.** Tempo
realista com uma VPS nova em mãos: 40 a 60 minutos.

### O que você precisa ter em mãos

| Item | Onde está |
|---|---|
| `advocme-backup-PRIVADA.asc` | `~/.advocme-secrets/` — **sem ela nada funciona** |
| Chave SSH da VPS de backup | `~/.ssh/` — para buscar o backup lá (nome em `backup-destino.txt`) |
| Acesso ao painel do provedor | Para criar a VPS nova e apontar o IP |
| Repositórios | `github.com/givasz/Adv.Backend` e `Adv.Frontend` |

### Passo a passo

**1. Pegar e abrir o backup mais recente**

```bash
ssh -i $BKPKEY root@$BKP "ls -1t /var/backups/advocme/ | head -3"
scp -i $BKPKEY root@$BKP:/var/backups/advocme/advocme-AAAA-MM-DD.tar.gpg .
export GNUPGHOME=~/.advocme-secrets/gpg-keyring
mkdir aberto && gpg -d advocme-AAAA-MM-DD.tar.gpg | tar -xzf - -C aberto
cat aberto/MANIFESTO.txt      # confira a contagem por tabela ANTES de seguir
```

**2. Preparar a VPS nova** (Ubuntu 24.04; o manifesto diz as versões exatas do dia)

```bash
apt update && apt install -y postgresql-16 nginx certbot python3-certbot-nginx gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm i -g pm2
```

**3. Recriar banco e usuário** (a senha sai de `aberto/env-producao.txt`)

```bash
sudo -u postgres psql -c "CREATE USER advocme WITH PASSWORD '<a do DATABASE_URL>';"
sudo -u postgres psql -c "CREATE DATABASE advocme OWNER advocme;"
gunzip -c aberto/banco-advocme.sql.gz | psql -v ON_ERROR_STOP=1 "postgresql://advocme:<senha>@127.0.0.1:5432/advocme"
```

**4. Subir a aplicação**

```bash
mkdir -p /root/advocme-backend && cd /root/advocme-backend
cp aberto/env-producao.txt .env && chmod 600 .env
cp aberto/bi-credenciais.txt .bi-credenciais && chmod 600 .bi-credenciais
mkdir -p prisma && cp aberto/schema.prisma prisma/
# do seu PC, com o repositório: npm run build && scp -r dist package.json package-lock.json ...
npm ci --omit=dev && npx prisma generate
pm2 start "node dist/main.js" --name advocme-backend && pm2 save && pm2 startup
```

**5. nginx e HTTPS**

```bash
cp aberto/nginx-advocme-api.conf /etc/nginx/sites-available/advocme-api
ln -s /etc/nginx/sites-available/advocme-api /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d <domínio novo>
```

Os certificados **não** são copiados de propósito: são reemitidos em segundos e
guardar chave privada de TLS em backup só aumenta o estrago de um vazamento.

**6. Frontend** — Netlify reconstrói do git sozinho. Se o endereço da API mudou,
atualize a variável no painel e refaça o build.

**7. Religar o backup na máquina nova** — sem isto você está sem rede de novo:

```bash
install -m 755 backend/scripts/backup-diario.sh /usr/local/bin/advocme-backup
mkdir -p /etc/advocme-backup && chmod 700 /etc/advocme-backup
cp ~/.advocme-secrets/advocme-backup-PUBLICA.asc /etc/advocme-backup/publica.asc
gpg --import /etc/advocme-backup/publica.asc
echo "7F272D9A0CD9EBB05D20E208E7CAE2202A9D7709:6:" | gpg --import-ownertrust
ssh-keygen -t ed25519 -N "" -C advocme-backup-offsite -f /root/.ssh/advocme_backup_offsite
# copie o .pub e siga a seção "Trocar a VPS de produção" abaixo
vi /etc/advocme-backup/backup.conf && chmod 600 /etc/advocme-backup/backup.conf
crontab -e   # 15 3 * * * /usr/local/bin/advocme-backup >> /var/log/advocme-backup.log 2>&1
/usr/local/bin/advocme-backup    # rode uma vez à mão e confira as 4 linhas
```

---

## 9. Ligar o alerta de falha (Healthchecks.io) — 2 minutos

Único passo que depende de você.

1. Crie a conta grátis em <https://healthchecks.io> (20 checks no plano free).
2. **New Check** → nome `ADVOC.ME backup diário` → **Period** 1 day →
   **Grace time** 2 hours → Save.
3. Copie a URL de ping (`https://hc-ping.com/<uuid>`) e cole na VPS:

```bash
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 \
  "sed -i 's|^ADVOCME_HC_URL=.*|ADVOCME_HC_URL=https://hc-ping.com/COLE-O-UUID-AQUI|' /etc/advocme-backup/backup.conf && grep HC_URL /etc/advocme-backup/backup.conf"
```

4. Teste: `ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 /usr/local/bin/advocme-backup`
   — o check deve ficar verde no painel em segundos.

A partir daí você recebe e-mail se o backup falhar **e** se ele simplesmente
parar de acontecer.

---

## 10. Trocar a VPS de produção

O `authorized_keys` da VPS de backup trava a chave em `from="74.208.118.111"`. Com
outro IP, a entrega é recusada (e o Healthchecks avisa). Antes de desligar a VPS
velha:

```bash
ssh -i $BKPKEY root@$BKP
cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.antes-$(date +%F)
# edite a linha "advocme-backup-offsite": troque o from= pelo IP novo
# e a chave pública pela da máquina nova, se você gerou outra
vi /root/.ssh/authorized_keys
sshd -t     # valida a configuração antes de confiar nela
```

Depois rode o backup à mão na VPS nova e confira as 4 linhas de log.

> A VPS de **backup**  permanece a mesma. Se um dia ela também mudar,
> atualize `ADVOCME_OFFSITE_SSH` em `/etc/advocme-backup/backup.conf` e instale
> o `backend/scripts/backup-receber.sh` no destino novo.

---

## 11. Comandos de emergência

```bash
# Está tudo funcionando?
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 "tail -5 /var/log/advocme-backup.log"
ssh -i $BKPKEY root@$BKP "ls -lht /var/backups/advocme/ | head -5"

# Backup agora, fora de hora (antes de um deploy arriscado)
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 /usr/local/bin/advocme-backup

# Qual o backup mais recente lá fora?
ssh -i $BKPKEY root@$BKP "ls -1t /var/backups/advocme/ | head -1"

# Trazer e abrir
scp -i $BKPKEY root@$BKP:/var/backups/advocme/advocme-AAAA-MM-DD.tar.gpg .
export GNUPGHOME=~/.advocme-secrets/gpg-keyring
gpg -d advocme-AAAA-MM-DD.tar.gpg | tar -xzf - -C aberto/

# Ver o que tem dentro sem extrair tudo
gpg -d advocme-AAAA-MM-DD.tar.gpg | tar -tzf -

# O arquivo local de um dia está íntegro?
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 "gunzip -t /root/backups/advocme-diario-AAAA-MM-DD.sql.gz && echo INTEGRO"

# Dump manual de segurança antes de mexer no schema
ssh -i ~/.advocme-secrets/vpskey root@74.208.118.111 \
  'DB=$(grep -E "^DATABASE_URL=" /root/advocme-backend/.env | cut -d= -f2- | tr -d "\""); pg_dump --no-owner --no-acl "$DB" | gzip > /root/backups/advocme-$(date +%F-%H%M)-pre-mudanca.sql.gz'
```

---

## 12. O teste de restauração de 04/09/2026

Não foi conferência de arquivo: foi restauração de verdade, **usando o backup
que veio da VPS de backup** (não a cópia local), num banco isolado
`advocme_restore_teste`, criado e derrubado no fim. O banco `advocme` de produção
não foi tocado em momento algum, e nenhum serviço foi reiniciado.

| Verificação | Resultado |
|---|---|
| `sha256` produção → VPS de backup → PC | Idêntico ponta a ponta |
| Decifra com a chave privada | 8 arquivos, todos legíveis |
| Restauração com `ON_ERROR_STOP=1` | Sem um erro |
| 22 tabelas do schema `public` | Contagem idêntica em todas |
| Schema `bi` (1 tabela, 14 views, 4 funções, 1 índice) | Idêntico |
| `bi.area_mapa` | 37 = 37 |
| 3 fotos (data URI) | `md5` idêntico byte a byte |
| Fotos abrem como imagem? | 2 JPEG 512×512 decodificados do banco restaurado |
| 25 hashes de senha | Todos idênticos |

Testes de falha, no mesmo dia:

| Cenário | Comportamento |
|---|---|
| Banco inalcançável | Sai com código 1 e registra `FALHA:` |
| Destino off-site inalcançável | Sai com código 255 e registra `FALHA:` (a cópia local sobrevive) |
| Lixo em texto enviado ao receptor | `RECUSADO: conteúdo não é um pacote OpenPGP` — o backup do dia **não** é substituído |
| Stream cortado (< 1024 bytes) | `RECUSADO` — idem |
| Chave de envio tentando `cat authorized_keys` | Ignorado; o comando forçado roda no lugar |
| Retenção, 6 casos datados | Os 6 se comportaram como especificado |

**Refaça este teste a cada 6 meses.** Backup que ninguém restaura há um ano é
uma suposição, não um backup.

---

## 13. Pendências conhecidas

- [ ] **Ligar o Healthchecks.io** (seção 9). Enquanto não estiver ligado, a
      falha só aparece para quem for olhar o log.
- [ ] **Guardar `advocme-backup-PRIVADA.asc` fora do PC.** Hoje ela existe em um
      lugar só; se o PC morrer, os backups da VPS de backup ficam ilegíveis.
- [ ] **A chave privada de acesso à VPS de backup está dentro dela mesma** —
      um `scp` com aspas erradas gravou o arquivo em `/root/` de lá.
      Quem entrar naquela VPS leva a chave que a abre. Nada foi removido: a
      decisão é do dono.
- [ ] O Bakaninha divide a VPS de produção (banco `bakaninha`, 8 MB) e **não tem
      backup nenhum** — decisão consciente de 04/09/2026, registrada aqui para
      não virar surpresa.
- [ ] Uma terceira cópia fora do seu controle (Cloudflare R2, grátis neste
      volume) fecharia o 3-2-1 de verdade. O script já tem o ponto de extensão.
