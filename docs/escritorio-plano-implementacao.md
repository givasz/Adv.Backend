# Escritório: plano de implementação

> Escrito em 2026-08-21 depois de auditar o código e o banco de produção.
> **Executado no mesmo dia.** As três fases estão no código e no `main` dos dois
> repos. O que falta é operação: subir o backend na VPS e decidir o que fazer com
> dois registros antigos de produção (ver **O que ainda falta**, no fim).

| Fase | O quê | Estado |
|---|---|---|
| 1 | Fechar o furo do dono (`DEMO_USER`) | ✅ feito |
| 2 | Membros de verdade (convite, sair sem apagar) | ✅ feito |
| 3 | Assistente virtual do escritório | ✅ feito |

---

## O estado que motivou o plano

Auditado, não suposto, em 2026-08-21 — vale como registro do que estava errado:

- `firms.controller.ts` tinha `const DEMO_USER = 'demo-user-id'` fixo e **não lia o
  header `Authorization`**. Qualquer usuário logado que abrisse `/escritorio/editar`
  editava **o mesmo escritório** e podia salvar por cima.
- `reconcileLawyers()` casava advogados por número de OAB e, para cada nome novo,
  **criava um usuário fantasma** (`firm-<id>-xxxx@members.local`, senha `member`)
  com `Profile` publicado. Para cada nome que saía da lista, fazia
  **`profile.delete()`** — salvar com a lista vazia apagava o perfil de todos.
- O dono **não era membro** do próprio escritório.
- `/escritorio/editar` só era linkado na landing; do `/painel` não havia caminho.
- O `invited` de `FirmMemberStatus` existia no schema e nunca tinha sido usado.

**Produção (VPS, conferido em 2026-08-21):** 1 `Firm`, 1 `FirmMembership`,
**2 usuários `@members.local`**, 22 usuários no total.

---

## Fase 1 — O dono passou a ser a conta logada

`d83a169` (backend) · `1840ebd` (frontend)

- Todas as rotas `/firms/me` resolvem o dono por `userIdFromHeader()` e devolvem
  **401** sem sessão. Escritório não é recurso anônimo: diferente do perfil
  individual, aqui não existe rascunho demo.
- O `user.upsert` do dono saiu — o dono já existe porque está logado.
- `profile.delete()` virou `firmMembership.delete()`: quem sai perde o vínculo,
  nunca o perfil.
- No editor, erro do servidor deixou de virar "Tudo salvo": o `saveFirm` confere
  `res.ok` e a tela mostra "Não salvo" com o motivo em linha.

---

## Fase 2 — Advogado entra por convite, com a conta dele

`cb9826d` (backend) · `6813bd3` (frontend)

**Schema (aditivo):** `model FirmInvite` e `FirmMembership.previousPlan`.

- **Convite por e-mail.** Quem já tem conta recebe `FirmMembership(invited)` ligado
  ao perfil que já é dele. Quem não tem vira um `FirmInvite`, convertido em vínculo
  pendente no cadastro (`auth.service.resolvePendingInvites`).
- **O dono é o primeiro membro**, com o próprio perfil e `role: owner`. Nada
  duplicado, e ele não pode ser removido do próprio escritório.
- **Sair não apaga.** `releaseMember()` devolve o plano individual guardado em
  `previousPlan` (enquanto ativo, o membro usa o tier do escritório) e apaga só o
  vínculo.
- **Um advogado, uma sociedade.** `profileId` é único: convidar quem já está em
  outro escritório dá erro explicativo.
- O `PUT /firms/me` grava **só o institucional** — a lista de advogados não entra
  mais pelo corpo.
- **Entrada pelo painel.** `components/painel/EscritorioCard.tsx` cobre os três
  estados: convite recebido (decide ali mesmo), escritório próprio (atalho para
  gerenciar) e nenhum dos dois (criar). Hooks próprios num componente separado por
  causa da saída antecipada do painel (React #310).

**Rotas novas:** `POST /firms/me/members`, `DELETE /firms/me/members/:kind/:id`,
`GET /firms/me/invites`, `POST /firms/me/invites/:id/{accept,decline}`,
`POST /firms/me/leave`.

**Testes:** `firms.service.spec.ts` cobre convite, saída e aceite com um Prisma
dublê — o banco de produção é Postgres e não existe na máquina de desenvolvimento.

---

## Fase 3 — Assistente virtual do escritório

`7016359` (backend) · `2879e49` (frontend)

A triagem de duas telas virou a mesma conversa guiada do perfil individual.

### Não é IA — e não pode virar

Roteiro fechado (chips e perguntas fixas), selo **"Automático"**, nunca a palavra
"IA". Um LLM respondendo dúvida de cliente na página de um advogado seria consulta
jurídica automatizada, que é onde o Prov. 205/2021 pega.

### As três decisões, e como ficaram

1. **Escolha de advogado.** Opcional, "Tanto faz" primeiro, lista alfabética, só
   quem atua na área escolhida (cai na lista inteira se ninguém tiver aquela área).
   Nunca "o mais indicado para o seu caso": isso é ranking.
2. **Sem grade.** A sociedade não tem agenda por advogado, então o roteiro pergunta
   **dia e período** (`FIRM_PERIODS`) — como uma secretária faria — e o escritório
   confirma.
3. **Destino do pedido.** `Firm.assistantRoute`: `institutional` (padrão, mantém o
   atendimento centralizado) ou `lawyer`. Sem escolha de advogado ou sem número
   dele, volta para o institucional. Opção no editor, em rádio.

### Reuso, não cópia

O motor da conversa (falas, "digitando…", cancelamento de falas pendentes) e as
peças visuais saíram do `AssistantChat` (**739 → 510 linhas**) para
`components/assistant/{useConversation.ts,pieces.tsx}`. Os dois assistentes usam os
mesmos. O do escritório declara a paleta "Papel & Tinta" nas variáveis `--c-*` que
as peças esperam — é literalmente o mesmo componente pintado de outro jeito.

O `npm run smoke` passou a **percorrer as duas conversas** até o link do WhatsApp:
abrir a página não prova que o roteiro anda, e agora o motor é compartilhado.

**Versão 2 (ainda não feita):** se o visitante escolher um advogado que **tem**
assistente e grade configurados, o assistente do escritório passa a bola e a
conversa segue com os horários reais dele.

---

## O que ainda falta

Nada disso é código — é operação, e depende de decisão:

1. **Subir o backend na VPS.** O schema mudou (aditivo: `FirmInvite`,
   `FirmMembership.previousPlan`, `Firm.assistantRoute`). Procedimento em
   `DEPLOY-VPS.md`: build → scp → `prisma db push` → `pm2 restart`. **Dump antes.**
   Enquanto isso não acontece, a produção segue com o código antigo.
2. **Os 2 usuários `@members.local`.** São os perfis fantasma criados pelo código
   antigo. Nada os apaga automaticamente — eles continuam como membros do
   escritório e o dono pode removê-los pelo editor (o que agora só desfaz o
   vínculo). Se a intenção for limpar de vez, é decisão sua: apagar os usuários ou
   deixar como estão.
3. **O escritório órfão do `demo-user-id`.** Com a fase 1 no ar, ninguém consegue
   editá-lo (não existe sessão para esse id). Provavelmente é teste e pode ser
   apagado — conferir antes.

---

## Regras do projeto que valeram nas três fases

- **OAB acima de tudo.** `REGRAS.md` na raiz de cada repo. Na dúvida, a opção mais
  restritiva. Todo texto que o visitante lê passa por `checkCompliance`.
- **Sem modais.** Páginas (`components/ui/SubPage.tsx`, volta por `?voltar=`) ou
  painéis em linha (`components/escritorio/PainelEmLinha.tsx`).
- **Limites por plano são do servidor.** `backend/src/plans.ts` é a fonte; o front
  espelha em `frontend/src/lib/plans.ts`.
- **Antes do push:** `npx tsc --noEmit`, `npm run test`, `npm run build` e
  **`npm run smoke`** (21 rotas + as 2 conversas, num navegador real).
- **Terminar = commitar na `main` e dar push nos dois repos.**
- **Backend mudou → atualizar a VPS** (`DEPLOY-VPS.md`, na raiz, fora do git).
  Dump antes de schema destrutivo.
