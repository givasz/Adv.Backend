# Segurança — auditoria de 21/08/2026

Aplicação das regras de `vulnerabilidades.md` (OWASP Top 10 + race conditions +
validação + privacidade) ao código do ADVOC.ME. Este arquivo registra **o que
estava aberto, o que foi fechado e o que continua em aberto** — para a próxima
auditoria começar de onde esta parou.

> ⚠️ **Antes do próximo deploy, leia o [checklist de produção](#checklist-de-produção).**
> A API agora **recusa subir** com segredo de desenvolvimento (isso é proposital).

---

## Corrigido

### 1. Rascunho anônimo compartilhado entre visitantes — vazamento de dado pessoal

`PUT/GET /api/profiles/me` sem sessão caía num usuário fixo (`demo-user-id`) que
era **o mesmo para todo mundo**. Quem preenchesse o editor sem criar conta gravava
nome, WhatsApp e e-mail numa linha que o próximo visitante anônimo abria e lia.

Escrever agora exige sessão (401). Sem conta, o rascunho fica no navegador —
`frontend/src/lib/api.ts` só chama a API quando há sessão.
`backend/src/profiles/profiles.controller.ts`

### 2. Link `javascript:` salvo no perfil — XSS armazenado na página pública

`socials[].url` e `contact.scheduling` iam para o banco sem conferência de esquema
e viravam `href` na página pública. React **não** bloqueia `href="javascript:…"` —
só avisa no console. Um perfil publicado executava script na nossa origem, com
acesso ao `localStorage` (sessão inclusive) de quem visitasse.

Duas camadas: `safeUrl()` recusa na gravação (`backend/src/security/sanitize.ts`) e
`safeHref()` recusa na renderização (`frontend/src/lib/safeUrl.ts`), o que também
cobre o que já está gravado.

### 3. Segredos de desenvolvimento valendo em produção

`AUTH_SESSION_SECRET` caía em `'dev-user-secret'` e `ADMIN_PASSWORD` em
`'dev-admin-123'` quando a variável faltava. Com o valor no repositório, qualquer
pessoa assinava a própria sessão — de advogado ou de admin.

`assertSecureConfig()` roda no boot e **derruba o processo** em produção listando o
que falta; em desenvolvimento só avisa. `backend/src/security/config.ts`

### 4. IA aberta e sem teto — conta de provedor pago exposta

`POST /api/ai/generate` não pedia sessão, não tinha limite e lia o plano do corpo
da requisição (`plan: "premium"` liberava o recurso pago). Um laço de terminal
esvaziava o orçamento da Anthropic.

Teto por IP (40/h, 8/min) e por usuário (120/h); plano lido da **assinatura no
banco**; entrada do prompt com teto de itens e caracteres.
`backend/src/ai/ai.controller.ts`

### 5. Login e painel admin sem limite de tentativas

Nenhuma trava contra dicionário — nem no login do advogado, nem no do painel de
moderação (que tem uma senha só). Limites: login 20/IP e 8/e-mail, cadastro 8/IP,
admin 6/IP e 40 globais. `backend/src/security/rate-limit.ts`

### 6. `X-Forwarded-For` confiável sem proxy — todo limite era contornável

O IP vinha de um cabeçalho que o próprio cliente escreve: trocar a linha a cada
requisição zerava denúncia, suporte e login. Agora só vale com `TRUST_PROXY=1`.
`backend/src/security/net.ts`

### 7. Enumeração de contas pelo tempo de resposta

Login com e-mail inexistente respondia sem calcular hash — rápido demais, o que
entregava quais e-mails têm conta. Agora o caminho "não existe" paga o mesmo custo
(`burnPasswordTime`). A mensagem já era única.

### 8. Corpo da requisição sem tipo, tamanho ou formato

`PUT /profiles/me` e `PUT /firms/me` recebiam `any` e gravavam quase direto: texto
de um milhão de caracteres, listas infinitas, `brandAccent` com CSS, `customDomain`
com qualquer coisa, foto em `data:text/html`, e `kind` de rede desconhecido — este
último **derrubava a página pública inteira** (o ícone não existia).

Saneamento na fronteira com teto em todo campo (`backend/src/security/sanitize.ts`),
corpo limitado a 1 MB, e `slugify` com teto de 60 caracteres.

### 9. Sem cabeçalhos de segurança

API e página respondiam sem CSP, `nosniff`, `X-Frame-Options`, HSTS ou
`Permissions-Policy`. Adicionados nos dois lados: `backend/src/security/headers.ts`
e `frontend/netlify.toml`.

### 10. Hash de senha abaixo do recomendado

scrypt com os parâmetros padrão do Node (N=2¹⁴). Novos hashes usam N=2¹⁵, r=8, p=3 e
**carregam os próprios parâmetros**, então as senhas antigas continuam entrando.

### 11. Sem trilha de eventos de segurança

Entrada, cadastro, recusa de acesso e estouro de limite agora saem em JSON de uma
linha. Nunca com senha, token ou e-mail: o e-mail vira impressão digital curta, que
correlaciona tentativas contra a mesma conta sem guardar o endereço.
`backend/src/security/audit-log.ts`

### 12. Sair não encerrava a sessão no servidor

O token era assinado e sem estado: apagar o navegador não dizia nada ao servidor,
e uma cópia do token feita antes seguia entrando por até 7 dias.

Agora cada login grava uma linha `Session`, e o token carrega o id dela — é a
existência dessa linha que faz a sessão valer. Uma linha por APARELHO: sair no
celular não derruba o computador. `POST /api/auth/logout` apaga a sessão daquele
aparelho; `POST /api/auth/logout-all` derruba todas (aparelho perdido, senha
vazada). Custo: uma leitura por chave primária nas rotas autenticadas, que já
falavam com o banco de qualquer jeito. `backend/src/auth/session.service.ts`

### 13. Direitos do titular (LGPD art. 18) sem porta de entrada

Ver, levar e apagar os próprios dados dependia de escrever para o suporte e
alguém mexer no banco à mão — o que não é um direito, é um favor.

`GET /api/account/data` devolve tudo em JSON aberto; `DELETE /api/account` apaga
a conta e o que depende dela. A tela fica em `/conta/dados`, no menu da conta.
Duas decisões que valem registro:

- **Exportar é só o que é dele.** Uma denúncia tem dois titulares: o advogado
  denunciado e quem denunciou. O pacote leva motivo e data; o e-mail e o texto de
  quem denunciou ficam de fora — exportá-los entregaria o denunciante ao
  denunciado.
- **Excluir é excluir**, e exige a senha. Nada de marcar "inativo" e seguir
  guardando. Antes de apagar, os membros do escritório do usuário voltam ao plano
  individual que tinham — senão a exclusão do dono rebaixaria terceiros em
  silêncio. `backend/src/account/`

### 14. Schema de desenvolvimento desandava em silêncio

`prisma/schema.dev.prisma` (SQLite) era mantido à mão e chegou a estar três
modelos atrás do de produção — o efeito era o cadastro quebrar só no ambiente
local, que é onde se testa. Agora ele é GERADO do schema de produção
(`npm run prisma:dev-schema`), então não tem como divergir.

### 15. Sessão no `localStorage` — um XSS levava a conta embora

O token de sessão ficava no `localStorage` e ia no cabeçalho `Authorization`.
Qualquer script que conseguisse rodar na nossa origem (um XSS, uma extensão, uma
dependência comprometida) lia o token e entrava como o advogado, de outra máquina,
pelos dias que faltassem para vencer. Era o item 2 de "em aberto" desta auditoria.

Agora a credencial é um **cookie `HttpOnly`**: o JavaScript da página não a lê —
nem o nosso, nem o de um invasor. O que mudou por inteiro:

- **A credencial é sorteada, não assinada.** 32 bytes aleatórios no cookie; o
  banco guarda só o SHA-256 deles. Antes, o token era um HMAC sobre um id `cuid`
  (que não é aleatório): quem obtivesse o segredo de assinatura poderia fabricar
  sessões. E o valor guardado no banco *era* metade da credencial — um dump do
  Postgres bastava. Hoje não: um dump traz hashes.
- **`Secure` sempre em produção e `SameSite` decidido por requisição.** `Lax`
  quando o front e a API são do mesmo site (advoc.me + api.advoc.me), `None` no
  arranjo de hoje (front no Netlify, API na VPS), em que `Lax` impediria o login.
  Prefixo `__Host-` quando os atributos permitem, o que fecha a injeção de cookie
  por subdomínio (fixação de sessão). `backend/src/auth/cookies.ts`
- **CSRF, que o cookie criou.** Cookie o navegador manda sozinho — então um
  formulário em outro site chamaria `DELETE /api/account` com a sessão do advogado
  anexada. Toda escrita autenticada agora exige o token da sessão no cabeçalho
  `x-csrf-token` (derivado por HMAC do id da sessão: sem linha extra no banco, sem
  leitura a mais) **e** uma `Origin` da lista do `FRONTEND_ORIGIN` — a mesma lista
  do CORS. `backend/src/auth/csrf.ts`
- **Validação num ponto só.** Nenhum controller lê cabeçalho de autenticação: todos
  chamam `sessions.requireUser(req)`, e é lá dentro que a sessão é conferida, o
  CSRF é exigido e o prazo é renovado. Não há como esquecer numa rota nova.
- **Prazo com dois relógios.** Vencimento por inatividade (12 h sem "lembrar de
  mim", 30 dias com) empurrado para a frente enquanto a pessoa usa, e um teto
  absoluto (24 h / 180 dias) que renovação nenhuma ultrapassa — sem ele, uma
  sessão usada todo dia viveria para sempre, e um cookie roubado junto com ela.
- **"Lembrar de mim".** Marcado (padrão), o cookie tem `Max-Age` e sobrevive ao
  fechar do navegador. Desmarcado, é cookie de sessão do navegador e a sessão
  também vence antes no servidor — o certo num computador emprestado.

Custo na VPS: a renovação só grava quando já passou metade do prazo (~1 escrita a
cada 15 dias por pessoa ativa) e um cache curto em memória absorve a rajada de
chamadas que uma tela do painel dispara. Onde as sessões moram é uma variável de
ambiente (`SESSION_STORE=prisma|redis`), não uma refatoração.
`backend/src/auth/`

### 16. Painel admin: token no `sessionStorage` e nenhuma revogação

O painel de moderação — que decide o que sai do ar — guardava um token assinado no
`sessionStorage` e o mandava como `Authorization: Bearer`. Dois problemas: era
legível por qualquer script que rodasse naquela página, e não havia como encerrar
a sessão antes das 8 horas, porque o token não tinha estado nenhum do outro lado.

Agora o painel usa o mesmo desenho da sessão do advogado — cookie HttpOnly com
segredo sorteado, hash do lado do servidor, CSRF nas escritas — com duas
diferenças deliberadas:

- **As sessões do painel ficam em memória**, não no banco. Não há linha `User`
  para o admin (ele vem do `.env`), e são poucas sessões de poucas horas. O preço
  é que reiniciar o processo desloga o painel, o que num painel de moderação é
  aceitável e até saudável.
- **O cookie vale só em `/api/admin`.** Todas as rotas do painel moram lá, então
  o cookie do admin não viaja junto de nenhuma visita a perfil público.

A porta virou uma função só, em vez de três cópias em três controllers — uma rota
nova do painel não tem como esquecer metade da verificação.
`backend/src/admin/admin-auth.ts`

> **Atualização (27/08/2026).** As duas ressalvas acima caíram no item 17: as
> sessões do painel saíram da memória para o banco, e o token estático legado
> deixou de valer em produção.

### 17. O painel não tinha identidade, papéis nem rastro

O item 16 fechou *como* alguém entra no painel. Ficou aberto o que existe do lado
de dentro — e ali havia três buracos que só apareciam juntos:

**Um usuário e uma senha, no `.env`.** Não havia papéis: quem entrava para
responder um chamado de suporte podia tirar qualquer perfil do ar. Não havia
autoria: `adminLabel()` devolvia o nome do `.env`, e nenhuma decisão registrava
quem a tomou, porque só existia "o admin". Não havia como desligar o acesso de
uma pessoa sem trocar a senha de todas.

**Nenhuma ação deixava rastro consultável.** `AuditLog` é a trilha do *perfil* (o
que o advogado mudou) e `logSecurityEvent` escreve JSON no `console`, que some com
a rotação do pm2. Restringir um perfil não gravava quem, quando nem por quê — ruim
para o advogado, que não tinha como contestar, e pior para quem administra, que não
tinha como se defender de uma acusação de censura arbitrária.

**O `x-admin-token` era um portão lateral.** Um bearer sem expiração que, por
desenho, pulava a checagem de CSRF. E, pior do que isso: ao ser aceito, ele
**retornava antes da conferência de permissão** — ou seja, com o token na mão, todo
o trabalho de papéis seria contornável. Isso foi encontrado pelo teste que exige
que o token de serviço não decida nada, e corrigido antes de sair daqui.

O que existe agora:

- **`AdminUser` com papel** — `owner`, `moderator`, `support`, `readonly`. A
  tabela do que cada um abre é um arquivo só (`admin/admin-roles.ts`), no espírito
  do `planFeatures.ts` do front. O corte é entre **decidir** e **consultar**: quem
  responde suporte vê a fila de denúncias e não tira nada do ar.
- **Segundo fator (TOTP, RFC 6238)** obrigatório para quem decide. Implementado com
  `node:crypto`, sem pacote novo, e testado contra os vetores da norma — um TOTP
  "quase certo" não falha em lugar nenhum, apenas nunca deixa ninguém entrar.
  Enquanto o segundo fator estiver pendente a pessoa entra e consulta, mas nenhuma
  decisão é aplicada.
- **Sessões no banco** (`AdminSession`), com prazo ocioso e teto absoluto, como a
  do advogado. Reiniciar a API não desloga mais ninguém, e derrubar o aparelho de
  alguém virou um botão. Desativar um acesso encerra as sessões no mesmo ato.
- **`AdminAction`: quem, quando, sobre quem, e por quê.** O motivo é obrigatório em
  toda decisão que afeta alguém — e é o MESMO texto que a pessoa afetada lê. O IP
  entra como impressão digital, nunca o endereço.
- **O token estático não vale em produção.** Fora dela ainda entra, para `curl` na
  máquina de quem desenvolve, e mesmo lá apenas como `readonly`.
- **A porta de emergência se fecha sozinha.** A credencial do `.env` só entra
  enquanto a tabela `AdminUser` estiver vazia — é por ela que o primeiro
  administrador nasce, e ela para de valer no instante em que ele existe, sem
  deploy e sem variável para lembrar de tirar. Se o banco estiver fora, a resposta
  é "já existe administrador": um banco intermitente não pode virar o caminho mais
  fácil para o painel.

Duas travas leem o próprio código-fonte e falham sozinhas
(`admin/admin-rotas.spec.ts`), porque nenhuma revisão humana pega isto de forma
confiável na rota número quinze: **toda rota do painel pede uma permissão que
existe na tabela**, e **toda escrita do painel deixa registro**.
`backend/src/admin/`

---

## Verificado em execução

Com a API rodando (`node dist/main.js`):

| Teste | Resultado |
|---|---|
| `PUT /profiles/me` sem sessão | `401` |
| Token de sessão adulterado | `401` |
| `kind: "faq"` (pago) em conta Free | `403` |
| 25 tentativas de login | 8 passam, depois `429` (teto por e-mail) |
| 12 gerações de IA em sequência | 8 passam, depois `429` |
| 8 tentativas no painel admin | 6 passam, depois `429` |
| `X-Forwarded-For` trocado a cada requisição | continua `429` |
| Cabeçalhos de resposta | CSP, nosniff, DENY, no-referrer, Permissions-Policy |
| Sair num aparelho | o cookie daquele aparelho vira `401`; o outro segue em `200` |
| Encerrar todas | as 3 sessões abertas viram `401` de uma vez |
| Exportar dados | traz conta, perfil e chamados; **sem** o e-mail de quem denunciou |
| Excluir com senha errada | `400`, conta intacta |
| Excluir com a senha certa | perfil público vira `404` e o banco fica com 0 linhas em 9 tabelas |

A sessão por cookie tem um teste de ponta a ponta por HTTP de verdade
(`backend/src/auth/session.http.spec.ts`): um cliente com pote de cookies entra,
volta numa requisição nova só com o cookie guardado, apanha `403` ao escrever sem
o `x-csrf-token`, passa com ele, sai — e depois o cookie copiado antes do logout
recebe `401`, assim como um pedido idêntico partido de outra `Origin`.

O percurso da LGPD foi percorrido num navegador de verdade contra a API real:
cadastro pela tela → baixar o arquivo → senha errada recusada → exclusão →
sessão morta e perfil fora do ar, sem nenhum erro de JavaScript.

Mais 142 testes automatizados no backend (79 deles de autenticação e segurança) e
289 no frontend. `npm test` nos dois; `npm run smoke` abre as 24 rotas num
navegador real — a do painel de moderação entrou na lista quando ele passou a
perguntar ao servidor quem está logado antes de decidir o que desenhar.

---

## Em aberto (com o motivo)

1. **Enumeração de contas no cadastro.** `POST /auth/signup` responde "já existe uma
   conta com este e-mail". A regra pede resposta neutra — mas isso só funciona com
   **confirmação por e-mail**, que a plataforma ainda não tem: sem ela, a pessoa
   ficaria sem saber por que a conta não foi criada. Mitigado por hora com o teto de
   8 cadastros/hora por IP. *Resolver junto com o envio de e-mail.*

2. **Cookie de terceiros no arranjo atual.** Com o front no Netlify e a API na VPS,
   o cookie da sessão é `SameSite=None` — e navegadores vêm apertando o cerco a
   cookies de terceiros. Funciona hoje em todos eles; o desfecho limpo é pôr a API
   num subdomínio do site (`api.advoc.me`), o que passa o cookie para `SameSite=Lax`
   sozinho, sem mudar uma linha de código. *Fazer junto com o registro do domínio.*

3. **Cobrança simulada.** `POST /profiles/me/plan` ativa plano sem pagamento. É
   assim de propósito (plataforma em teste) e está documentado no código — mas
   **antes de cobrar de verdade**, essa porta tem que passar a aceitar apenas o
   webhook do provedor, com assinatura conferida e chave de idempotência.

4. **`connect-src https:` no CSP.** Aberto porque o host da API vem de variável de
   ambiente. Ao fixar o domínio do backend, trocar pela origem exata.

5. **Honeypots.** Não implementados: a varredura automatizada bate no host do
   Netlify, não na API — uma rota falsa no Nest não veria esse tráfego. Se quiser o
   sinal, o lugar é uma função do Netlify.

6. ~~**Troca de senha do ADVOGADO não existe.**~~ **Resolvido em 27/08/2026.**
   `POST /api/auth/senha` pede a senha atual e a nova (mesma regra de força do
   cadastro), encerra TODAS as sessões e reabre só a de quem está trocando. Pedir
   a senha atual é o que impede um cookie roubado de virar posse da conta: sem
   essa etapa, quem tivesse a sessão trocaria a senha e trancaria o dono do lado
   de fora. Teto de 10 tentativas por hora, por IP e por conta — a senha atual é
   conferida aqui, e sem teto a rota seria um oráculo para adivinhá-la a partir de
   uma sessão sequestrada, sem passar pelo limite do login.

   Estava marcado como "resolver junto com o envio de e-mail" e não precisava:
   e-mail só faz falta no *esqueci minha senha*, que continua em aberto. A tela
   fica em `/conta/dados`.

7. **O painel não tem recuperação de senha.** De propósito, por enquanto: sem
   envio de e-mail, um "esqueci a senha" seria um caminho a mais para entrar sem
   ser convidado. Hoje a saída é `npm run admin:create --reset` no servidor, que
   também derruba as sessões da conta.

---

## Dependências (varredura de 21/08/2026)

### Corrigido

**react-router 6.30.4 → 6.30.6** e, junto, dois redirecionamentos abertos que
existiam no nosso próprio código — o aviso do react-router foi o que fez procurar:

- `caminhoDeVolta()` barrava `//outro.site` mas **não** `/\outro.site`. O navegador
  lê os dois como endereço externo, então `?voltar=/\site-falso` fazia a subpágina
  devolver a pessoa para fora. Também passou a recusar caractere de controle.
- `AuthPage` usava `?next=` **sem validação nenhuma**: `/entrar?next=https://site-falso`
  mandava o advogado **recém-autenticado** direto para a página de quem montou o
  link. Agora passa pela mesma trava.

### Conhecido e não alcançável (avaliado item a item)

O backend tem 10 avisos do `npm audit`, **todos** exigindo Nest 10 → 11 (major).
A migração não entra numa correção de segurança sem ser pedida — e nenhum dos
avisos é alcançável neste código:

| Pacote | Aviso | Por que não alcança |
|---|---|---|
| `@nestjs/core` | injeção em SSE (`GHSA-36xv-jgw5-4q75`, CVSS 6.1) | não há rota SSE; a falha exige mapear dado do usuário em `message.type`/`id` |
| `multer` | 5 avisos de negação de serviço | não há upload de arquivo — a foto é data URI no corpo JSON |
| `lodash` | injeção de código via `_.template` | transitivo do `@nestjs/config`; não é chamado com entrada do usuário |
| `body-parser` | limite inválido desativa o teto em silêncio | nosso limite é `'1mb'` (válido), então o teto vale |
| `qs` | DoS no `stringify` com `encodeValuesOnly` | usamos só o parse |

O frontend fica com 2 avisos, **ambos só no servidor de desenvolvimento**
(`vite`/`esbuild`) — não vão para o `dist` publicado. A correção também é major.

**Reavaliar** a cada `npm audit`: o argumento acima é "não usamos esse recurso".
No dia em que entrar SSE, upload de arquivo ou `_.template`, ele deixa de valer.

---

## Checklist de produção

### Esta versão exige `prisma db push` e criar o primeiro administrador — ✅ aplicado

> `db push` feito na VPS em 27/08/2026, 15h54, com dump em
> `/root/backups/advocme-2026-08-27-painel-identidade.sql.gz`. Conferido contra a
> API de produção: token estático recusado com 403, escrita sem `x-csrf-token`
> recusada com 403, decisão sem motivo recusada com 400, entrada registrada em
> `AdminAction` e logout derrubando a sessão no servidor.
> Primeiro administrador criado no mesmo dia (`admingiva`, papel `owner`): com
> ele a porta de emergência do `.env` fechou sozinha — entrar por ela passou a
> devolver 401. A conta abre com o segundo fator pendente, e nesse estado só as
> permissões de leitura vêm no `/api/admin/me`.

Três tabelas novas (`AdminUser`, `AdminSession`, `AdminAction`) e um enum
(`AdminRole`). Nada é destrutivo — são tabelas novas, e nenhuma coluna existente
mudou —, mas o dump antes continua valendo como regra da casa.

```bash
# na VPS, com o dist novo já enviado:
pg_dump ... > backup-antes.sql                    # nunca pule
npx prisma db push                                # tabelas do painel
pm2 restart advocme-backend

# primeiro administrador (a credencial do .env para de valer depois deste passo):
node dist/admin/admin-cli.js --email voce@dominio --name "Seu Nome" --role owner
# anote a senha sorteada: ela não é mostrada de novo
```

No primeiro acesso o painel pede o segundo fator. Enquanto ele não existir,
nenhuma decisão é aplicada — dá para consultar a fila, e é isso.

`ADMIN_USERNAME`/`ADMIN_PASSWORD` continuam no `.env` como porta de emergência
(elas voltam a valer se a tabela `AdminUser` ficar vazia). `ADMIN_TOKEN` pode
sair: em produção ele não é mais aceito.


### Esta versão exige `prisma db push` (e esvaziar `Session` antes) — ✅ aplicado

> Feito na VPS em 21/08/2026, 22h58, com backup em
> `/root/advocme-antes-cookie-2026-08-21-2254.sql`. Conferido em produção: cookie
> `__Host-advocme_session` saindo `HttpOnly; Secure; SameSite=None` com 30 dias,
> sessão sobrevivendo a fechar e reabrir o navegador (teste em Chromium de verdade
> contra o Netlify), escrita sem `x-csrf-token` recusada com 403, pedido de outra
> `Origin` recusado com 403, e sair derrubando a sessão no servidor. O registro do
> procedimento fica abaixo para a próxima máquina.

A tabela `Session` ganhou três colunas obrigatórias — `tokenHash`,
`absoluteExpiresAt` e `remember` —, e `id` deixou de ter valor automático. As
linhas antigas não têm como preenchê-las, e o `db push` recusa criar uma coluna
obrigatória numa tabela com dados. Como as sessões antigas já não valeriam de
qualquer forma (a credencial mudou de formato E de lugar), o caminho é esvaziar a
tabela:

```bash
# na VPS, com o dist novo já enviado:
pg_dump ... > backup-antes.sql                              # nunca pule
psql "$DATABASE_URL" -c 'TRUNCATE TABLE "Session";'          # sessões antigas
npx prisma db push                                           # colunas novas
pm2 restart advocme-backend
```

**Todo mundo é deslogado uma vez** neste deploy — o token que estava no
`localStorage` não é mais aceito e o navegador precisa receber o cookie novo.
Avise, ou vai parecer defeito.

Confira também, no `.env` da VPS, que `FRONTEND_ORIGIN` lista as origens reais do
site: com cookie e `credentials`, essa lista deixou de ser conforto e virou a
fronteira — é ela que o CORS e o anti-CSRF conferem.


**A API não sobe** se qualquer item de segredo estiver com valor de exemplo. Antes
do próximo `pm2 restart`, confira o `.env` da VPS. Para gerar cada segredo (um
valor diferente por variável):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variável | Exigência em produção |
|---|---|
| `AUTH_SESSION_SECRET` | 24+ caracteres aleatórios, diferente do admin |
| `ADMIN_SESSION_SECRET` | 24+ caracteres aleatórios |
| `ADMIN_PASSWORD` | 12+ caracteres, não pode ser a de exemplo |
| `ADMIN_TOKEN` | remova, ou 24+ caracteres (é um bearer sem validade) |
| `FRONTEND_ORIGIN` | origem(ns) reais do site, separadas por vírgula |
| `TRUST_PROXY` | `1` **se** houver Nginx/proxy à frente; senão deixe `0` |
| `NODE_ENV` | `production` — **obrigatório**: é o que faz o cookie sair `Secure`. Sem ele (ou sem `TRUST_PROXY=1`), o `SameSite=None` cai para `Lax` e ninguém entra, sem erro nenhum no log. |

Trocar `AUTH_SESSION_SECRET` **desloga todo mundo** (as sessões atuais foram
assinadas com o valor antigo) — é o comportamento correto e só acontece uma vez.
