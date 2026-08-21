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

Mais 64 testes automatizados no backend (incluindo 26 novos de segurança) e 262 no
frontend. `npm test` nos dois; `npm run smoke` abre as 21 rotas num navegador real.

---

## Em aberto (com o motivo)

1. **Enumeração de contas no cadastro.** `POST /auth/signup` responde "já existe uma
   conta com este e-mail". A regra pede resposta neutra — mas isso só funciona com
   **confirmação por e-mail**, que a plataforma ainda não tem: sem ela, a pessoa
   ficaria sem saber por que a conta não foi criada. Mitigado por hora com o teto de
   8 cadastros/hora por IP. *Resolver junto com o envio de e-mail.*

2. **Logout não invalida a sessão no servidor.** O token é assinado e sem estado
   (7 dias). Sair apaga o token do navegador, mas um token copiado antes continua
   valendo. Correção: coluna `tokenVersion` em `User`, incluída na assinatura e
   incrementada no logout e na troca de senha. *Exige migração.*

3. **Direitos do titular (LGPD).** Não há endpoint para exportar nem para apagar os
   próprios dados. Hoje isso é feito à mão pelo suporte. *Próximo passo natural do
   painel da conta.*

4. **Sessão no `localStorage`.** Fica exposta a um XSS. Com o CSP e o saneamento de
   links a superfície diminuiu bastante; a solução completa é cookie `HttpOnly` +
   `SameSite`, que exige o backend em subdomínio do frontend.

5. **Cobrança simulada.** `POST /profiles/me/plan` ativa plano sem pagamento. É
   assim de propósito (plataforma em teste) e está documentado no código — mas
   **antes de cobrar de verdade**, essa porta tem que passar a aceitar apenas o
   webhook do provedor, com assinatura conferida e chave de idempotência.

6. **`connect-src https:` no CSP.** Aberto porque o host da API vem de variável de
   ambiente. Ao fixar o domínio do backend, trocar pela origem exata.

7. **Honeypots.** Não implementados: a varredura automatizada bate no host do
   Netlify, não na API — uma rota falsa no Nest não veria esse tráfego. Se quiser o
   sinal, o lugar é uma função do Netlify.

8. **`prisma/schema.dev.prisma` está atrás do schema de produção** (não tem
   `FirmInvite`, entre outros). Rodar local com SQLite quebra no cadastro. Não é
   falha de segurança, mas atrapalha justamente os testes que a exercitam.

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
| `NODE_ENV` | `production` |

Trocar `AUTH_SESSION_SECRET` **desloga todo mundo** (as sessões atuais foram
assinadas com o valor antigo) — é o comportamento correto e só acontece uma vez.
