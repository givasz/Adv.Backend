# Guia de Deploy — advoc.me

Como o advoc.me está publicado hoje e como manter/atualizar. O projeto são **dois
repositórios independentes**:

| Repo | O que é | Onde roda |
|------|---------|-----------|
| **Adv.Frontend** | SPA React + Vite (Tailwind) | **Netlify** (site estático) |
| **Adv.Backend** | API NestJS + Prisma | **Render** (web service) + **Postgres** (Render) |

```
  Navegador ──HTTPS──▶  Netlify (frontend estático)
                             │
                             │  fetch VITE_API_URL/api/...
                             ▼
                        Render (NestJS)  ──▶  Postgres (Render)
                             │
                             └──▶  Gemini API (geração de bio)
```

O deploy é **automático por push**: todo push na branch `main` de cada repo dispara um
novo build no Netlify / Render (Auto-Deploy on commit).

---

## 1. Backend no Render

### 1.1. Como está configurado
Há um **`render.yaml`** (blueprint) na raiz do repo. Ele cria:
- um **Web Service** `advocme-backend` (Node), e
- um **Postgres** gerenciado `advocme-db`.

Comandos (definidos no `render.yaml`; se você criou o serviço **manualmente**, use os
mesmos):

```
Build Command:  npm install && npx prisma generate && npm run build
Start Command:  npx prisma db push --skip-generate && node dist/main.js
Health Check:   /api/directory
Instance Type:  Free
```

> **Por que `prisma db push` no Start?** Em vez de migrations versionadas, a produção
> **sincroniza o schema direto** (`schema.prisma` é a fonte da verdade). No boot, o
> `db push` cria/atualiza tabelas e colunas automaticamente. Assim, **adicionar um campo
> novo é só editar `schema.prisma` e dar push** — o próximo deploy aplica sozinho.
> (Em plano pago, dá pra mover o `db push` para um *Pre-Deploy Command*.)

### 1.2. Variáveis de ambiente (Render → Environment)
| Variável | Valor | Origem |
|----------|-------|--------|
| `DATABASE_URL` | Internal Database URL do `advocme-db` | auto (blueprint) ou cole manual |
| `AI_PROVIDER` | `gemini` | render.yaml |
| `AI_MODEL` | `gemini-2.5-flash` | render.yaml |
| `GEMINI_API_KEY` | chave `AIza...`/`AQ...` de [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) | **secret** |
| `FRONTEND_ORIGIN` | URL do Netlify (ex.: `https://advocme.netlify.app`) — várias separadas por vírgula | **secret** |
| `ADMIN_TOKEN` | token legado (header `x-admin-token`) | **secret** |
| `ADMIN_USERNAME` | login do painel de moderação | **secret** |
| `ADMIN_PASSWORD` | senha do painel | **secret** |
| `ADMIN_SESSION_SECRET` | segredo p/ assinar o token de sessão (HMAC), longo e aleatório | **secret** |
| `NODE_VERSION` | `20` | render.yaml |

> Gerar um segredo forte: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

### 1.3. Criar o Postgres (se não usou o blueprint)
Render → **New + → Postgres** → nome `advocme-db` → **Free** → mesma região do web
service → copie a **Internal Database URL** e cole em `DATABASE_URL`.

### 1.4. Ressalvas do plano Free
- O serviço **"dorme"** após inatividade → o **1º acesso** demora alguns segundos (cold start).
- O **Postgres Free expira ~30 dias** após criado (recriar quando expirar).

---

## 2. Frontend no Netlify

### 2.1. Como está configurado
Há um **`netlify.toml`** na raiz do repo — o Netlify lê tudo sozinho:
```
Build command:      npm run build      (tsc + vite build)
Publish directory:  dist
NODE_VERSION:        20
Redirect SPA:        /*  →  /index.html  200   (React Router)
```

### 2.2. Variáveis de ambiente (Netlify → Site configuration → Environment variables)
| Variável | Valor | Efeito |
|----------|-------|--------|
| `VITE_API_URL` | URL do backend no Render, **sem barra final** | front fala com o backend |
| `VITE_USE_REAL_API` | `true` *(opcional)* | usa o backend para **tudo** (ver Modos) |
| `VITE_ADMIN_PATH` | *(opcional)* caminho do painel escondido | default `painel-mod-7fq3k9x2a` |

> Variáveis `VITE_*` são "assadas" **no build** — mudou uma env, precisa **rebuildar**
> (Deploys → Trigger deploy), não basta reiniciar.

### 2.3. Modos de operação (o que `VITE_USE_REAL_API` muda)
- **Híbrido (recomendado)** — só `VITE_API_URL`. Perfis ficam no **localStorage** do
  navegador; a **geração de bio** usa o backend (Gemini). Funciona sem depender do banco.
- **Real completo** — também `VITE_USE_REAL_API=true`. Perfis, busca, moderação e
  conferência de OAB passam pelo **Postgres**. (Protótipo: ainda usa um `DEMO_USER`, sem
  login por advogado.)

---

## 3. Ordem do setup inicial (primeira vez)

1. **Backend primeiro** (para ter a URL): crie o Postgres + web service no Render, defina
   os secrets, faça o deploy. Teste: `https://<seu-backend>.onrender.com/api/directory`
   deve responder `[]`.
2. **Frontend**: importe o repo no Netlify, defina `VITE_API_URL` = URL do Render, deploy.
   Anote a URL do site (ex.: renomeie para `advocme` → `https://advocme.netlify.app`).
3. **Feche o CORS**: no Render, ajuste `FRONTEND_ORIGIN` = URL real do Netlify → o serviço
   reinicia. Sem isso, o navegador bloqueia as chamadas por CORS.

---

## 4. Atualizações do dia a dia

- **Código**: `git push` na `main` do repo correspondente → Netlify/Render **rebuildam
  sozinhos**.
- **Schema do banco** (campo/tabela novos): edite `backend/prisma/schema.prisma`, push →
  o `prisma db push` no boot do Render aplica no Postgres. **Não precisa migration.**
- **Trocar de IA**: no Render, `AI_PROVIDER=anthropic` + `AI_MODEL=claude-sonnet-5` +
  `ANTHROPIC_API_KEY` (ou volte para `gemini`). Sem chave nenhuma, a geração cai num
  **template seguro** (não quebra).

---

## 5. Painel de moderação (admin)

- URL: `https://<seu-site>.netlify.app/<VITE_ADMIN_PATH>` (default
  `.../painel-mod-7fq3k9x2a`) — rota `noindex`, escondida.
- Login com `ADMIN_USERNAME` + `ADMIN_PASSWORD` (do Render). A sessão é um token HMAC
  assinado com `ADMIN_SESSION_SECRET`.
- Abas: **Denúncias** (moderação), **Advogados** (busca por nome/OAB, ver/moderar) e
  **Conferência OAB**.

---

## 6. O que NÃO vai para o Git (e por quê)
Ver `.gitignore` de cada repo:
- `**/.env` — segredos ficam **só** nas Environment Variables do Render/Netlify.
- `backend/prisma/dev.db*` — banco SQLite **local de dev**.
- `backend/prisma/migrations/` — migrations são **dev-only** (produção usa `db push`).
- `dist/`, `node_modules/`, caches.

Existe um `schema.dev.prisma` (SQLite) só para desenvolvimento local; **produção usa
`schema.prisma` (Postgres)**.

---

## 7. Troubleshooting

| Sintoma | Causa provável | Correção |
|---------|----------------|----------|
| Erro de **CORS** no console | `FRONTEND_ORIGIN` no Render ≠ URL do Netlify | ajuste `FRONTEND_ORIGIN` e redeploy do backend |
| Editor **trava no spinner** / `Unexpected end of JSON` em `getDraft` | `VITE_USE_REAL_API=true` com banco vazio | use **modo híbrido** (remova a var e rebuilde) |
| 1º acesso muito **lento** | cold start do Render Free | normal; aquece após o 1º request |
| Build do Netlify falha | erro de TS/Vite | rode `npm run build` local e corrija antes do push |
| Bio gerada é sempre o "template" | `GEMINI_API_KEY` ausente/errada ou cota estourada | confira a chave; troque o `AI_MODEL` (ex.: `gemini-flash-latest`) |
| Tabela nova não existe em prod | deploy não rodou o `db push` | confirme o **Start Command**; refaça deploy |

---

## 8. Desenvolvimento local (resumo)

```bash
# Backend (SQLite local)
cd backend && npm install
cp .env.example .env                 # DATABASE_URL="file:./dev.db"
npx prisma migrate dev --schema prisma/schema.dev.prisma
npm run build && node dist/main.js   # ou: npm run start:dev

# Frontend
cd frontend && npm install
npm run dev                          # http://localhost:5173 (mock; sem backend)
```

O frontend roda **sozinho no mock** (localStorage). Para falar com o backend local, o
proxy do Vite já encaminha `/api` → `localhost:3333`.
