# Segurança — auditoria de 01/09/2026

Terceira passagem de `vulnerabilidades.md` (OWASP Top 10 + race conditions +
validação + privacidade) sobre o código do ADVOC.ME. As duas primeiras (21/08 e
27/08) estão preservadas abaixo, a partir de "Auditoria de 21/08/2026".

Esta rodada olhou o que nasceu **depois** da anterior — cadeia de IA, consulta de
CEP, endereço do escritório, camada de BI, ciclo da assinatura, prévia de link na
borda, métricas — e refez a varredura geral em cima do que já existia.

> 🚨 **Leia primeiro o item 1.** Ele exige ação sua num servidor, e nenhuma linha
> de código conserta o que ele descreve.

---

## 1. 🚨 Os segredos de produção estavam num arquivo de texto — CRÍTICO

`DEPLOY-VPS.md`, na raiz do projeto, trazia **em texto puro**:

| O quê | O que ele abre |
|---|---|
| Chave SSH privada (ed25519, **sem senha**) | a VPS inteira — e é o **único** caminho de entrada desde 25/08 |
| Senha do root | `sudo`, `su` e o console de recuperação do provedor |
| `AUTH_SESSION_SECRET` | deriva o token anti-CSRF de **qualquer** sessão |
| `ADMIN_SESSION_SECRET`, `ADMIN_PASSWORD`, `ADMIN_TOKEN` | o painel de moderação |
| Senha do Postgres | a base inteira (mitigado: escuta só em `127.0.0.1`) |
| `GEMINI_API_KEY` | a conta de IA, e a fatura dela |

Nenhum deles estava versionado — o arquivo mora só na máquina local, e os
`DEPLOY.md` dos dois repositórios estão limpos (conferido). Mas a regra 5 de
`vulnerabilidades.md` fala em código, comentário, log e mensagem de erro, e o
documento de deploy é o quinto lugar — o mais fácil de esquecer justamente porque
não é código, e o que mais circula de um projeto: vai por mensagem, entra em
anexo de chamado, é colado inteiro numa conversa com IA e sobe junto no dia em que
alguém versionar a pasta raiz.

A ironia que marca o ponto: a chave privada estava logo abaixo de um aviso que
pedia "guarde uma cópia desta chave **fora deste arquivo**".

**O que foi feito.** Os valores saíram do projeto e foram para
`~/.advocme-secrets/` (`vpskey`, `producao.env`, `LEIA-ME.md`), com uma cópia
íntegra do documento original ao lado — nada se perdeu, e a chave foi conferida
com `ssh-keygen -y` antes de o original ser tocado. O `DEPLOY-VPS.md` ficou com o
PROCEDIMENTO e com a FORMA do `.env` (nome de cada variável e o que ela decide),
que é o que precisa ser lido e compartilhado.

**O que falta, e só você pode fazer.** Tirar um segredo do arquivo não o torna
secreto de novo: eles estiveram legíveis por meses, e não há como saber por onde
o arquivo passou. `~/.advocme-secrets/LEIA-ME.md` traz a ordem completa. Em
resumo, e nesta ordem:

1. **Chave SSH** — gerar par novo, testar a entrada com ele **ainda com o antigo
   funcionando**, e só então remover a linha velha do `authorized_keys`.
2. **Senha do root** (`passwd`) — ela ainda vale para o console do provedor.
3. **`AUTH_SESSION_SECRET`** — desloga todo mundo uma vez, e é o certo.
4. **`ADMIN_SESSION_SECRET`** e **`ADMIN_PASSWORD`**.
5. **`ADMIN_TOKEN`** — apagar a linha. Em produção o código já não o aceita
   (`tokenEstaticoConfere`); mantê-lo é guardar um segredo que não protege nada.
6. **`GEMINI_API_KEY`** — revogar e gerar outra.
7. **Senha do Postgres** — a menos urgente (só `127.0.0.1`), mas na lista.

A chave da VPS não está nesta máquina, então o deploy da API não sai daqui: a
rotação é sua, pelo console do provedor ou de onde a chave estiver.

---

## 2. A busca pública mostrava perfil que a moderação tirou do ar

`GET /api/directory` montava o `where` espalhando dois objetos:

```ts
{ ...this.visivelAoPublico(),          // OR: [não restrito, prazo vencido]
  ...(termo ? { OR: [nome, cidade, área] } : {}) }
```

Duas chaves `OR` no mesmo objeto literal — **a segunda sobrescreve a primeira**.
Sem termo de busca a condição de moderação valia; **com** termo ela sumia, e um
perfil restringido voltava a aparecer para quem digitasse o nome dele. Que é
exatamente como se procura um advogado específico.

O cabeçalho de `visivelAoPublico()` avisava que bastava uma consulta esquecer o
`moderationStatus` para a medida se desfazer. Não foi esquecimento: foi uma
colisão de chave que os dois caminhos escondiam um do outro — o código parecia o
mesmo, e nenhum teste separava "com termo" de "sem termo".

Agora as condições são itens de um `AND`, que não tem como colidir. O teste
compara a FORMA da consulta nos dois caminhos.
`backend/src/profiles/profiles.service.ts`

> Foi encontrado por um teste que eu escrevi para outra coisa (o teto do termo de
> busca) e que falhou por um motivo que eu não esperava. Vale registrar: a
> asserção "sem termo, nenhum filtro de texto" só falha se houver um `OR` que não
> deveria estar ali.

---

## 3. Redirecionamento aberto no nosso domínio, por conta grátis

`GET /api/profiles/:slug/avatar` respondia `302` para `avatarUrl` quando a foto
era uma URL https — o outro formato que o saneamento aceita, para quem prefere
hospedar a imagem fora.

Criar conta é grátis. Bastava salvar `avatarUrl: "https://site-do-golpe/…"`,
publicar o perfil, e `advoc.me/api/profiles/<slug>/avatar` passava a levar a
qualquer lugar — com o link exibindo **o nosso domínio**, que é justamente o que
um filtro de e-mail, um antivírus e a própria pessoa conferem antes de clicar. De
quebra, todo visitante da prévia entregava IP e User-Agent a um terceiro que ele
não escolheu, com a nossa origem de intermediária.

A correção **não** é buscar a imagem por conta própria: isso trocaria um
redirecionamento aberto por um proxy de saída, com SSRF junto. É notar que a rota
nunca precisou desse caso — uma foto que já é uma URL pública já é buscável pelo
robô do mensageiro, e o `og:image` agora aponta direto para ela. A rota serve só
o que é nosso: os bytes que existem apenas no nosso banco.
`backend/src/profiles/profiles.service.ts` + `frontend/src/lib/ogTags.ts`

---

## 4. O e-mail do advogado ia parar no log de segurança

`audit-log.ts` foi escrito para nunca gravar e-mail: o campo `subject` leva uma
impressão digital curta, que correlaciona tentativas contra a mesma conta sem
guardar o endereço.

O furo estava do outro lado. Quando um limite estoura, `enforceRateLimit` grava
uma linha com a **chave do limitador** dentro (`resource`) — e a chave do login
por e-mail era montada com o e-mail cru:

```ts
[`login:email:${email}`, AUTH_RATE_RULES.loginPerEmail]
```

Oito senhas erradas e o endereço ficava escrito no log da API — que sobrevive em
backup, sai em anexo de chamado e vai inteiro para o coletor. Um arquivo de log
com e-mails é a mesma lista de clientes que a proteção contra enumeração existe
para não entregar.

A chave passou a levar a impressão digital. Como ela é determinística, o limite
continua contando por conta, exatamente como antes.
`backend/src/auth/auth.controller.ts`

---

## 5. Qualquer estranho desligava o painel de moderação em 40 requisições

O login do painel tinha dois tetos: 6 por IP e **40 globais**, ambos em 15
minutos. O global existia contra a varredura distribuída — e criava um problema
maior do que resolvia: quarenta tentativas erradas, de qualquer lugar, trancavam
**todos** os administradores por quinze minutos. Sem conhecer um usuário, sem
saber uma senha, e renovável indefinidamente.

Num painel cuja função é tirar conteúdo irregular do ar, deixar que um estranho o
desligue de fora é falha de disponibilidade tão séria quanto a de acesso — e era
a mais barata de explorar que havia aqui.

Entrou um teto **por conta** (8/15min, pela impressão digital do usuário — é ele
que faz o trabalho fino contra dicionário, que trocar de IP não resolve), e o
global subiu para 400: volume que nenhum uso legítimo alcança, e que deixou de
ser alavanca. O por-IP não mudou.
`backend/src/security/rate-limit.ts` + `backend/src/admin/admin.controller.ts`

---

## 6. A busca pública devolvia megabytes de foto embutida

`GET /api/directory` trazia `avatarUrl` como veio do banco — data URI de até
~300 KB por perfil, 40 perfis por resposta. Rota pública, sem sessão e sem teto:
uma requisição barata devolvendo megabytes é amplificação de graça, e a conta do
tráfego é da VPS. O cabeçalho do `sitemap()` já tinha notado o problema para o
mapa do site; a busca ficou como estava.

Agora sai o **endereço** da foto (`/api/profiles/:slug/avatar`, que o navegador
busca sob demanda e guarda por uma hora), o termo de busca tem teto de 120
caracteres — acima disso não é busca, é varredura de tabela — e o corte de 40
resultados virou constante com nome.

⚠️ **Esta rota não é chamada por nenhuma tela.** `searchDirectory` existe em
`frontend/src/lib/api.ts` e ninguém a usa. Enquanto existir, é superfície pública
que precisa se defender sozinha (A02 pede remover o que não se usa). Se a decisão
for que não haverá diretório público, o certo é **remover a rota** — não deixá-la
de porta aberta esperando uma tela que talvez não venha.

---

---

## Varredura das 60 rotas — 01/09/2026 (segunda parte)

A primeira parte olhou o código por assunto. Esta percorreu **uma rota por vez**,
perguntando de cada: quem pode chamar, o que ela devolve, e se algo que não
deveria sair sai. As 60 estão classificadas em `backend/src/rotas.spec.ts`.

### 7. O endereço que o advogado mandou esconder ia para todo visitante

O editor tem um interruptor, "Mostrar o endereço no perfil", que promete com
estas palavras: *"O endereço fica só com você — não aparece na página nem no
cartão de contato que o visitante salva."* A dica abaixo dele diz para quem foi
feito: *"Quem atende em casa costuma deixar desligado."*

Quem cumpria a promessa era o React. A API mandava rua, número, complemento,
bairro e CEP para qualquer pessoa, junto do próprio interruptor, e o front é que
decidia não desenhar (`enderecoVisivel`, em `lib/endereco.ts`):

```bash
curl https://advoc.me/api/profiles/<slug> | jq .address
```

O dado exposto é, pela dica do próprio editor, o **endereço residencial** de um
advogado que pediu para escondê-lo. É controle de privacidade que só existe no
cliente — e cliente nunca foi barreira.

O cuidado já existia nos dois lugares DERIVADOS do endereço — o JSON-LD da prévia
de link e o vCard —, cada um com um comentário explicando que um endereço que a
página esconde não pode vazar por ali. Faltava na fonte dos dois.

A censura entrou em `toPublic`, que é a única passagem por onde só o visitante
passa. `toApi` não servia: ele atende o dono também, e o dono precisa continuar
vendo o que escondeu — senão o campo se apaga sozinho na tela dele.
`backend/src/profiles/profiles.service.ts`

### 8. A página do escritório era a porta dos fundos da moderação

`GET /api/firms/:slug` é pública e listava todo membro com vínculo ativo, sem
olhar o perfil de cada um. Duas consequências:

- **Perfil RESTRINGIDO continuava no ar.** A sanção tirava o advogado de
  `/:slug` e a página da sociedade seguia publicando nome, foto, bio, OAB e
  WhatsApp dele — no mesmo domínio, a um clique de distância.
- **Rascunho nunca publicado ia junto.** Quem aceitou o convite e não terminou o
  perfil tinha os próprios dados publicados pela página do escritório.

A causa é uma frase do próprio código. O comentário de `visivelAoPublico()` dizia:

> *"Virou método porque agora TRÊS portas devolvem perfil ao público (…). Se as
> três escrevessem a condição à mão, bastaria uma esquecer o `moderationStatus`
> para um perfil restrito voltar a circular pelo WhatsApp."*

O raciocínio estava certo e o número estava errado: as portas eram QUATRO. A
quarta mora em outro serviço — e por ser um método **privado**, ela não tinha
como chamá-lo. Então não filtrava nada.

Um método privado não é fronteira: ele protege quem consegue chamá-lo. A regra
virou `profiles/visibilidade.ts`, função exportada, que é a única forma de a
quinta porta nascer certa. O editor do escritório continua mostrando todo mundo,
de propósito: quem administra precisa ver o membro fora do ar para cobrar a
regularização.
`backend/src/firms/firms.service.ts` + `backend/src/profiles/visibilidade.ts`

### 9. O canal de contestação também se desligava de fora

Mesmo defeito do login do painel (item 5), no lugar em que dói mais.
`POST /api/appeals/contestar` é a porta de quem a suspensão impediu de entrar —
a única. O teto global era 60 em 15 minutos: sessenta requisições de qualquer
estranho fechavam o canal de contestar sanção para todo mundo.

Entrou teto por conta (8/15min, pela impressão digital do e-mail) e o global
subiu para 600. O teto por IP não mudou.
`backend/src/moderation/appeals.controller.ts`

### 10. Nada obrigava uma rota nova a ter porta

`admin-rotas.spec.ts` já cobrava que toda rota do PAINEL pedisse permissão
nomeada. **Fora do painel não havia nada.** Uma rota nova de advogado que
esquecesse `requireUser` entraria em produção respondendo a qualquer um, e
nenhum teste diria uma palavra.

`backend/src/rotas.spec.ts` fecha isso: lê os controllers, classifica cada rota
pela porta que ela usa, e exige que **toda rota sem porta esteja declarada em
`PUBLICAS` com o motivo escrito**. Ser pública passou a ser uma decisão que se
escreve, e não um esquecimento que se parece com uma.

Ele cobra mais quatro coisas:

- justificativa órfã falha (descrever uma rota que não existe mais é pior que não
  descrever nada — a próxima pessoa lê como se descrevesse);
- toda rota pública que ESCREVE precisa de uma barreira própria — assinatura HMAC,
  teto de tentativas, ou credencial conferida na mão;
- nenhum controller menciona `passwordHash`, `tokenHash`, `totpSecret` ou
  `password: true` no código (comentários que descrevem o corpo da requisição
  saem antes: receber senha é o trabalho do login);
- a lista tem de achar mais de 40 rotas, para o teste não passar por não achar
  nada.

Conferido que a trava falha de verdade: uma rota sem porta plantada de propósito
no controller de perfis é recusada.

### O que a varredura NÃO encontrou

| Conferido | Resultado |
|---|---|
| Hash de senha, `tokenHash`, `totpSecret` em resposta | Nenhum. Todas as consultas de `User` e `AdminUser` usam `select` explícito. |
| `GET /auth/me` | id, e-mail e o plano vigente. O `csrfToken` sai aqui de propósito — sem o cookie ele não autentica nada. |
| `POST /admin/me/totp/start` | Devolve o segredo TOTP, e só para o próprio admin, sobre a própria conta. É o passo de configurá-lo. |
| `POST /admin/admins`, `GET /admin/admins` | `select` explícito; a senha vem do corpo e nunca volta. |
| `GET /profiles/:slug` | `toApi` é whitelist campo a campo: `userId`, situação de cobrança e nota de moderação não saem. |
| `POST /appeals/contestar` | Erro genérico único, `burnPasswordTime` no caminho "não existe". Sem enumeração. |
| `POST /profiles/:slug/evento` | 204 sempre, inclusive ao recusar — não vira oráculo de quais slugs existem. |
| Escrita pública sem barreira | Nenhuma. Webhook por HMAC, denúncia e contestação por teto, logout pela própria credencial. |
| `POST /account/anonymize` | Parecia sem porta na varredura automática; delega para `remove()`, que exige sessão **e** a senha. |

---

---

## Por onde os dados do advogado saem — 01/09/2026 (terceira parte)

As duas primeiras partes olharam o código e as rotas. Esta seguiu o **dado**: de
cada campo que o advogado nos confia, para onde ele vai — inclusive pelos canais
que não são HTTP.

### 11. A promessa sobre treinamento de IA depende de um contrato que ninguém leu

`/legal/ia` afirma, sem ressalva:

> *"Não usamos os seus dados para treinar modelos de terceiros."*

E o que sai daqui não é anônimo. O prompt leva:

| Campo | Quando |
|---|---|
| **Nome** do advogado | frase de apresentação e bio |
| **Cidade/UF** e **áreas** | plano Max ("enriquecimento") |
| **O texto que ele já escreveu** (até 2000 caracteres) | ao pedir "melhorar" a bio ou uma resposta de FAQ |
| Palavras-chave e a pergunta do FAQ | sempre |

O problema não é o envio — é que **a promessa não é nossa para cumprir**. Quem
decide se treina é o provedor, no contrato dele. E a cadeia de produção
(`AI_PROVIDER=gemini,groq,openrouter`) é inteira de tier grátis, que é
historicamente onde o provedor se reserva esse direito — é o que se troca pelo
preço zero. O próprio catálogo já dizia isso de um deles em voz alta, sobre a
xAI: *"crédito mensal em troca de deixar a xAI treinar com o tráfego"*. O fato
estava escrito num comentário e nada no código o levava em conta.

**O que foi feito.** A postura virou um campo do catálogo
(`treinaComOsDados: 'nao' | 'talvez' | 'local'`), e `avisarSobreTreinoDeIa()`
reclama no boot quando a cadeia configurada contradiz a política publicada:

```
[privacidade] A cadeia de IA usa gemini — tier em que o provedor pode treinar
com o que enviamos (nome, cidade e o texto do advogado).
  /legal/ia promete "Não usamos os seus dados para treinar modelos de terceiros".
```

**AVISA, não bloqueia** — e isso é deliberado. Derrubar a IA em produção trocaria
um problema de privacidade por uma indisponibilidade, e *qual provedor é
aceitável* é decisão de quem responde pela plataforma, não do código.
`AI_TREINO_CIENTE=1` cala o aviso, para quem leu o contrato da própria chave.

**A decisão continua aberta**, e é de negócio, não de engenharia. Três saídas,
em ordem de custo:

1. **Ler o contrato da chave atual.** Se o tier em uso não treina, `AI_TREINO_CIENTE=1`
   e está encerrado — anote a data, porque termo de terceiro muda.
2. **Trocar a cadeia** por um provedor cujo contrato sustente a frase. Hoje o
   único do catálogo marcado como `'nao'` é a Anthropic, e ela é paga: é
   exatamente essa a troca.
3. **Ajustar a política** para dizer o que de fato acontece. É a saída honesta se
   a 1 e a 2 não couberem — mas é ela que eu **não** faria sem você mandar:
   enfraquecer uma promessa de privacidade publicada não é correção de bug.

⚠️ `treinaComOsDados` **envelhece**, como `custo`. É termo de terceiro, conferido
em 01/09/2026, e muda sem aviso.

### 12. O perfil de exemplo carrega um número de OAB de aparência real

`sampleProfile` (`frontend/src/lib/mockData.ts`) é renderizado na home, em
produção, como um perfil de advogado funcionando: nome **Marina Sales**, inscrição
**OAB/SP 214.870**, foto de uma pessoa real (Unsplash) e o `CnaLink` — o botão que
manda consultar a inscrição no Cadastro Nacional dos Advogados.

Não verifiquei se esse número pertence a alguém, e é justamente esse o ponto: se
pertencer, a home publica um perfil fabricado com a inscrição de um terceiro, e o
botão de consulta leva o visitante ao registro real dessa pessoa. O risco é
assimétrico — usar um número inequivocamente fictício não custa nada.

**Não mexi**: é decisão de produto sobre a vitrine, e mudar o texto da home sem
você pedir passa do que a auditoria deve fazer. A recomendação é trocar por um
número que não possa existir (uma faixa reservada, ou `OAB/SP 000.000`), ou
marcar o card como exemplo de forma visível no próprio perfil — hoje só o BOTÃO
da home diz "Ver um exemplo"; o perfil renderizado não diz nada.

### Os canais conferidos, e o que cada um deixa passar

| Canal | O que sai | Veredito |
|---|---|---|
| **Camada de BI** (`bi.dim_perfil` e afins) | slug, cidade/UF, plano, situação, contagens e **booleanos** (`tem_bio`, `tem_foto`), `length(bio)` | Minimizada de verdade: sem nome, e-mail, WhatsApp, endereço ou o texto da bio. `bi_leitor` tem `select` só no schema `bi` — nunca em `public`, logo nunca em `User` nem `Session`. |
| **Retenção** | eventos 400d, auditoria 365d, cobrança 365d | Prazos definidos e aplicados por rotina do próprio processo. |
| **Log de segurança** | impressão digital do e-mail, IP, User-Agent cortado | Corrigido na primeira parte desta auditoria (item 4). |
| **`localStorage`** | rascunho anônimo e o retrato de quem está logado | Com conta, o perfil vem só do servidor: `saveProfile` em modo real devolve `res.json()` e não grava nada. |
| **Prévia de link (borda)** | título, descrição, foto, JSON-LD | Endereço só entra no JSON-LD quando o advogado mandou aparecer — e agora a API também respeita isso (item 7). |
| **`/api/sitemap`** | slug e data | É o mapa do site: existir é o objetivo. |
| **Erros da API** | mensagem genérica | Nenhum controller ecoa `error.message`; o filtro padrão do Nest não devolve stack. |
| **Consulta de CEP** | o CEP digitado, a dois provedores públicos | Atravessa e não é gravado; passa pela nossa origem justamente para não entregar IP e origem do advogado a terceiro. |

---

## Verificado e considerado em ordem

O que foi lido nesta passagem e **não** virou correção, com o motivo — para a
próxima auditoria não refazer o caminho:

| Área | Conclusão |
|---|---|
| `GET /api/geo/cep/:cep` | Sem SSRF: só dígitos, dois hosts fixos, teto de tempo, nada gravado. Teto por IP já existia. |
| Cadeia de IA (`provedores.ts`) | Chave nunca sai em resposta nem em log; plano lido do banco; entrada com teto de itens e caracteres. O giro de chaves é memória de processo, não dado. |
| Webhook de cobrança | HMAC sobre o corpo **cru**, comparação em tempo constante, comprimento conferido antes, falha fechada sem segredo. Corpo cru preservado só nessa rota. |
| Sessão (cookie, CSRF, renovação) | Falha fechada em todos os ramos; cache invalidado no logout **e** no logout-all; teto absoluto de pé. |
| `escapeHtml`/`jsonLdSeguro` na borda | Cobrem atributo, corpo e o `</script` dentro do JSON-LD. A edge function falha para o lado seguro. |
| SVG do cartão de visita | Todo texto de usuário passa por `esc()`; o `dangerouslySetInnerHTML` recebe só o que o nosso gerador montou. |
| SQL | Nenhum `queryRaw`/`executeRaw` no código. O `bi_leitor.sql` recebe a senha por `-v`, não escrita no arquivo. |
| Escritório (`firms`) | Toda rota confere que o recurso é do escritório que o usuário administra, antes de mexer. Sem IDOR. |
| Paginação do painel | Teto de 100 por página, cursor no histórico, desempate por id. |
| `target="_blank"` sem `rel` | Os quatro casos são `<Link>` interno (mesma origem). Sem exposição de `window.opener`. |
| `BILLING_WEBHOOK_SECRET` fora do `assertSecureConfig` | Deixado de fora **de propósito**: a rota já falha fechada sem ele, e torná-lo obrigatório no boot derrubaria a API em produção por um segredo que hoje não protege tráfego nenhum. Entra na lista quando a cobrança for ligada. |

---

## Continua em aberto

Os itens 1 a 5 e 7 da auditoria anterior seguem válidos (enumeração no cadastro,
cookie de terceiros, cobrança simulada, `connect-src https:`, honeypots,
recuperação de senha do painel). Somam-se:

8. **A rotação dos segredos do item 1.** É a única pendência **crítica** desta
   auditoria, e não há código que a resolva.

9. **`GET /api/directory` sem tela e sem limite de tentativas.** Está mais magra
   e mais rígida, mas continua sendo uma rota pública que ninguém chama. Decidir:
   remover, ou dar-lhe teto por IP quando a tela de busca nascer.

---
---

# Auditoria de 21/08/2026


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
