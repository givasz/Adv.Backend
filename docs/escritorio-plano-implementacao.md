# Escritório: plano de implementação

> Documento de handoff. Escrito em 2026-08-21 depois de auditar o código e o banco
> de produção. O prompt pronto para abrir a próxima conversa está no fim.

O plano tem **três fases, nesta ordem**, porque cada uma depende da anterior:

| Fase | O quê | Depende de | Tamanho |
|---|---|---|---|
| 1 | Fechar o furo do dono (`DEMO_USER`) | — | minutos |
| 2 | Membros de verdade (convite, sair sem apagar) | fase 1 | grande |
| 3 | Assistente virtual do escritório | fase 2 (parcialmente) | médio |

---

## Estado atual — o que foi verificado, não suposto

**Backend** (`backend/src/firms/`):

- `firms.controller.ts` tem `const DEMO_USER = 'demo-user-id'` fixo e **não lê o
  header `Authorization`**. Está escrito lá: *"Autenticação (JWT) omitida neste
  protótipo"*. Todas as quatro rotas (`GET/PUT /firms/me`, `POST /firms/me/oab/request`)
  usam esse id.
- `firms.service.ts` → `reconcileLawyers()` casa os advogados por **número de OAB**;
  para cada nome novo **cria um usuário fantasma** (`firm-<id>-xxxx@members.local`,
  senha `member`) com `Profile` publicado e `plan: 'pro'`; e para cada membro que
  saiu da lista faz **`profile.delete()`**.
- `Firm.seatsPurchased = max(5, nº de advogados)` e `monthlyPrice` calculado por
  `firmMonthlyPrice()` — exibido, nunca cobrado.
- O schema **já tem** `FirmRole` (owner/admin/member) e `FirmMemberStatus`
  (**invited**/active). O serviço nunca usa `invited` e sempre grava `member`.

**Frontend**:

- `/escritorio/editar` (`pages/FirmEditor.tsx`) é a única porta de entrada e **só é
  linkada na landing**, no card do plano Escritório. Do `/painel` não há caminho.
- Os advogados são digitados numa lista dentro do editor (`lib/escritorio.ts`,
  tipo `FirmLawyer`), não convidados.
- `lawyersInNeutralOrder()` ordena alfabeticamente de propósito — *"sem hierarquia
  por senioridade/destaque"* (Prov. 205/2021 veda destaque).

**Produção (VPS, conferido em 2026-08-21):** 1 `Firm`, 1 `FirmMembership`,
**2 usuários `@members.local`**, 22 usuários no total. Ou seja: o caminho já foi
exercitado e os perfis fantasma existem no banco real.

### Consequências vivas

1. Qualquer usuário logado que abra `/escritorio/editar` **edita o mesmo escritório**
   (o do `demo-user-id`) — vê os dados e pode salvar por cima.
2. Salvar com a lista vazia **apaga os perfis** dos membros (`profile.delete`).
3. O dono **não é membro** do próprio escritório; se ele se listar, vira um perfil
   duplicado dele (o match é por OAB entre os membros existentes, não com o perfil
   pessoal).
4. Não há cobrança nem controle de assentos.

---

## Fase 1 — Fechar o furo do dono

**Objetivo:** o escritório passa a pertencer a quem está logado.

- `firms.controller.ts`: injetar `@Headers('authorization')` em todas as rotas e
  resolver o dono com `userIdFromHeader()` de `src/auth/user-auth.ts` — exatamente
  como `profiles.controller.ts` já faz (`private resolveUser(authorization)`).
- Sem sessão válida: **401/403**, não `DEMO_USER`. Escritório não é recurso anônimo.
- `firms.service.ts`: manter `ownerUserId` como chave de busca (já é), e **remover o
  `user.upsert` do dono demo** — o usuário já existe porque está logado.
- Migração do dado existente: decidir o que fazer com o escritório órfão do
  `demo-user-id` em produção (provavelmente apagar; conferir antes se é teste).

**Cuidado:** enquanto a fase 2 não existir, `reconcileLawyers` continua apagando
perfis. Vale já trocar o `profile.delete()` por **remover só o vínculo**
(`firmMembership.delete`) — uma linha, e para o sangramento.

**Pronto quando:** dois usuários diferentes veem escritórios diferentes, e sair da
lista não apaga o perfil de ninguém.

---

## Fase 2 — Membros de verdade

**Objetivo:** advogado do escritório é uma conta real, convidada — não um perfil
fantasma digitado pelo dono.

Fluxo alvo:

1. **Entrada pelo painel.** Card "Criar escritório" no `/painel` (hoje só na landing).
2. **Ao criar**, o dono vira `role: owner` e **o perfil individual dele entra como
   primeiro membro** (`status: active`), ocupando 1 dos 5 assentos. Nada duplicado.
3. **Convite por e-mail.** O dono informa o e-mail do sócio → cria
   `FirmMembership { status: 'invited' }` ligado ao perfil dele (se já existe conta)
   ou um convite pendente por e-mail (se não existe).
   - Já tem conta → aceita e o **perfil que ele já tem** passa a aparecer no
     escritório. Nada é recriado.
   - Não tem conta → cria conta + perfil normalmente e o convite se resolve na
     entrada.
4. **Sair não apaga.** Remover do escritório apaga o `FirmMembership`, nunca o
   `Profile`. O perfil é da pessoa.
5. **Assentos e cobrança.** R$99 até 5 advogados, +R$20 por extra
   (`FIRM_PRICING` em `plans.ts`, espelhado no front). Enquanto `active`, o membro
   usa o tier do escritório; ao sair, volta ao plano dele.

**Arquivos:** `firms.service.ts` (reescrever `reconcileLawyers` → convites),
`firms.controller.ts` (rotas de convite/aceite/remoção), `pages/FirmEditor.tsx`
(lista digitada → lista de membros + convites), `lib/escritorio.ts` (tipo
`FirmLawyer` → membro com estado), `pages/Painel.tsx` (entrada).

**Migração:** os 2 usuários `@members.local` de produção precisam de decisão —
converter em convite pendente ou apagar. Dump antes (ver `DEPLOY-VPS.md`).

**Pronto quando:** o dono aparece no próprio escritório sem duplicar, um sócio
convidado entra com a conta dele, e remover alguém não destrói nada.

---

## Fase 3 — Assistente virtual do escritório

**Objetivo:** o que hoje é a triagem de duas telas
(`components/escritorio/PainelTriagemWhatsApp.tsx`) vira a mesma conversa guiada do
perfil individual, adaptada a quem tem vários advogados e nenhuma agenda.

### Não é IA — e não pode virar

O assistente do perfil é um **roteiro fechado** (chips, perguntas fixas). A
interface nunca diz "IA": diz **"Assistente virtual de Pedro"** com o selo
**"Automático"**, e o código explica — *"deixa explícito que quem responde é um
robô, nunca o(a) advogado(a)"*. Um LLM respondendo dúvida de cliente na página de
um advogado seria **consulta jurídica automatizada**, que é onde o Prov. 205/2021
pega. **Manter roteiro fechado no escritório também.**

### Roteiro proposto

```
Assistente virtual do Andrade & Vieira          [Automático]

  Sobre qual assunto você precisa falar?
  › Direito de Família   › Trabalhista   › Empresarial     (áreas do escritório)

  Prefere falar com alguém específico?
  › Tanto faz   › Ana Beatriz   › Carlos Andrade           (ORDEM ALFABÉTICA)

  Presencial ou online?

  Que dia e período são melhores para você?
  › Esta semana, manhã   › Esta semana, tarde   › Próxima semana…

  Como podemos te chamar?

  → WhatsApp com tudo escrito, para o escritório confirmar
```

### As três decisões de projeto

1. **Escolha de advogado:** listar só quem atua na área, **em ordem alfabética**
   (`lawyersInNeutralOrder` já existe). **Nunca** "o mais indicado para o seu caso":
   isso é ranking, e ranking é o que a norma proíbe.
2. **Sem grade:** escritório não tem agenda por advogado. Perguntar **dia e
   período** (manhã/tarde), como uma secretária faria — e o escritório confirma.
3. **Destino do pedido:** opção no editor do escritório — WhatsApp **institucional**
   (padrão) ou **do advogado escolhido**. O institucional mantém o controle do
   atendimento, que é o que a maioria vai querer.

### Reuso

`components/profile/AssistantChat.tsx` (~700 linhas) é construído em cima de
`Profile`. Generalizar para um "anfitrião" (nome, avatar/monograma, tema, áreas,
grade **opcional**, WhatsApp) em vez de duplicar. O roteiro e os passos são os
mesmos; mudam dois passos (área, advogado) e a ausência de grade.
`lib/assistant.ts` (`buildAssistantMessage`, `assistantWhatsappHref`) idem.

**Versão 2 (depois):** se o visitante escolher um advogado que **tem** assistente e
grade configurados, o assistente do escritório passa a bola — a conversa segue com
os horários reais dele. Isso exige a fase 2 pronta.

**Pronto quando:** a página do escritório abre uma conversa guiada que termina num
WhatsApp com assunto, formato, preferência de horário e nome — sem ranking de
advogado e sem uma linha de orientação jurídica.

---

## Regras do projeto que valem para as três fases

- **OAB acima de tudo.** `REGRAS.md` na raiz de cada repo. Na dúvida, a opção mais
  restritiva. Todo texto que o visitante lê passa por `checkCompliance`.
- **Sem modais.** Telas sobrepostas viraram páginas (`components/ui/SubPage.tsx`,
  volta por `?voltar=` validada) ou painéis em linha
  (`components/escritorio/PainelEmLinha.tsx`). Não reintroduzir.
- **Limites por plano são do servidor.** `backend/src/plans.ts` é a fonte; o front
  espelha em `frontend/src/lib/plans.ts`.
- **Antes do push:** `npx tsc --noEmit`, `npm run test`, `npm run build` e
  **`npm run smoke`** (abre as 19 rotas num navegador real — é o que pega tela
  branca, que os outros três não pegam).
- **Terminar = commitar na `main` e dar push nos dois repos**, sem perguntar.
- **Backend mudou → atualizar a VPS** (procedimento e credenciais em
  `DEPLOY-VPS.md`, na raiz, fora do git). Dump antes de schema destrutivo.

---

## Prompt para a próxima conversa

Copie daqui para baixo:

---

Vamos implementar o **escritório (sociedade de advogados)** do advoc.me. O plano
completo, com o estado auditado do código e do banco de produção, está em
`backend/docs/escritorio-plano-implementacao.md` — **leia esse arquivo primeiro**,
inteiro, antes de propor qualquer coisa.

Faça na ordem: **fase 1** (fechar o furo do `DEMO_USER` no `firms.controller.ts`),
depois **fase 2** (membros de verdade, por convite), depois **fase 3** (assistente
virtual do escritório). Não pule para a fase seguinte sem a anterior estar
funcionando, commitada e no ar.

Antes de escrever código, leia também:

- `backend/src/firms/firms.controller.ts` e `firms.service.ts` — é o que vai mudar;
- `backend/src/profiles/profiles.controller.ts` — o `resolveUser(authorization)` de
  lá é o padrão a copiar na fase 1;
- `backend/prisma/schema.prisma` — modelos `Firm`, `FirmMembership`, enums
  `FirmRole` e `FirmMemberStatus` (o `invited` já existe e nunca foi usado);
- `frontend/src/pages/FirmEditor.tsx` e `frontend/src/lib/escritorio.ts`;
- `frontend/src/components/escritorio/` — a página pública e a triagem atual;
- `frontend/src/components/profile/AssistantChat.tsx` e `frontend/src/lib/assistant.ts`
  — o assistente individual, que a fase 3 generaliza (não duplica);
- `REGRAS.md` — as normas de publicidade da OAB, que mandam em tudo.

Regras de trabalho:

- **Nada de modal.** Página (`components/ui/SubPage.tsx`) ou painel em linha.
- O assistente do escritório é **roteiro fechado**, nunca LLM, e nunca chamado de
  "IA" na interface — selo "Automático", como no perfil.
- Nenhuma lista de advogados pode sugerir ranking ou destaque: ordem alfabética.
- Antes de cada push: `tsc --noEmit`, `npm run test`, `npm run build` e
  `npm run smoke` (com o `npm run dev` de pé).
- Terminar uma fase = commitar na `main` e dar push nos dois repos. Se o backend
  mudou, atualizar a VPS pelo procedimento do `DEPLOY-VPS.md` (dump antes de
  qualquer mudança destrutiva de schema).
- Em produção existem **2 usuários `@members.local`** e **1 escritório órfão** do
  `demo-user-id`. Antes de mexer neles, me pergunte o que fazer.

Comece me mostrando o que você entendeu do estado atual e o diff que pretende
fazer na fase 1. Não comece pelas três fases de uma vez.
