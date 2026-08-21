# Decisão: o advoc.me não verifica inscrições na OAB

**Data:** 21 de agosto de 2026
**Substitui:** `docs/oab-verificacao-escalonamento.md` (removido — descrevia as fases
2/3 de automação da conferência, que não vão existir).

## O que havia

Um workflow de conferência manual: o advogado **de plano pago** pedia
(`/editor?section=oab`), o perfil entrava em `pending`, um admin conferia no CNA por
uma aba própria do painel e decidia; aprovado, o perfil passava a exibir a marca
**"OAB conferida"**. Cada transição gerava um evento imutável em
`OabVerificationEvent`, e o snapshot vivia em oito colunas de `Profile`.

## Por que saiu

**1. Conformidade.** A marca era um recurso vendido — só os planos pagos podiam pedir
a conferência. Uma distinção **pública** que se compra é a lógica que o Provimento
205/2021 (Art. 5º, §1º) veda ao proibir desembolso por destaque. Pior: para o
visitante, a ausência da marca lia-se como demérito de um advogado **igualmente
inscrito**, que apenas não assinou. E "Selo 'OAB conferida'", como a copy comercial
dizia, tangencia a vedação a chancelas e símbolos oficiais (Art. 5º, §2º).

**2. Operação.** A conferência era manual e humana. Estendê-la ao plano gratuito —
que é o certo, se ela existisse — não escalava.

Note que as duas razões apontam para saídas opostas: a conformidade pedia
*conferir todo mundo*; a operação, *não conferir ninguém*. O que destravou foi
perceber que a plataforma não precisa ser a fonte da confiança.

## O que existe no lugar

Ao lado do número de inscrição, **todo** perfil — Free inclusive — traz um link para
a **consulta pública do Cadastro Nacional dos Advogados (CNA)**, base oficial e aberta
da OAB, já com o nome preenchido. Componente: `frontend/src/components/ui/CnaLink.tsx`.

- Sem ícone de check: nada foi verificado por nós, e um "✓" ao lado do número diria o
  contrário.
- Rótulo neutro ("conferir no CNA"), nunca "verificado" ou "conferido".
- Idêntico em todos os planos — não é recurso, é afordância.
- Custo operacional zero.

É mais honesto que a marca anterior: em vez de a plataforma afirmar "nós conferimos",
o perfil mostra ao visitante **onde ele mesmo confere**.

## O que isso troca

O controle de fraude deixa de ser **preventivo** e passa a ser **reativo**: nada impede
alguém de publicar um número falso. O que sustenta o outro lado:

- O canal de denúncia do perfil já tem o motivo `oab_invalid`
  (`backend/src/moderation/moderation.constants.ts`), e a moderação pode restringir o
  perfil.
- A aba **Advogados** do painel tem um botão "Conferir no CNA" para o moderador julgar
  a denúncia.
- Os Termos de Uso (item 2) já põem a veracidade do número sob responsabilidade
  exclusiva de quem publica, citando os arts. 297, 299 e 304 do Código Penal; o item 5
  passou a declarar expressamente que não verificamos.

Foi uma troca consciente. Se um dia existir uma API oficial de consulta ao CNA, a
conferência automática pode voltar — mas então **para todos os planos**, ou volta a
ser distinção paga e o problema recomeça.

## Nota sobre o REGRAS.md

O `REGRAS.md` (análise que originou o produto) recomenda "Validação de OAB no
cadastro" com marca informativa para perfis verificados. Essa recomendação está
**superada** por este documento: ela não previu o efeito de vender a marca, e supunha
uma verificação viável em escala, que não era.

## Pegada da remoção

- **Backend:** removidos `src/oab/verification/` (módulo, serviço e a interface de
  verificadores), 5 endpoints em `profiles.controller.ts`, 1 em `firms.controller.ts`.
- **Schema:** removidos o enum `OabStatus`, o model `OabVerificationEvent`, 8 colunas
  de `Profile` (`oabVerified`, `oabStatus`, `oabVerifiedAt`, `oabVerifiedMethod`,
  `oabVerifiedBy`, `oabRequestedAt`, `oabDecidedAt`, `oabReason`) e 2 de `Firm`.
- **Frontend:** removidos o `VerifiedBadge`, o `FirmVerified`, a aba de conferência do
  painel admin, a seção `?section=oab` do editor e a fila espelho do `api.ts`.
- **Índice de Confiança:** o fator `oab_conferida` (10 pontos, Pro) saiu; os pontos
  foram para os itens de conteúdo do Free, que agora satura em **82** (era 72). O teto
  segue em 100.

## Deploy

O schema perde colunas → `prisma db push` exige `--accept-data-loss`. **Dump antes**
(ver `DEPLOY-VPS.md`).

---

# Adendo (21/08/2026): a agenda-calendário também saiu

Na mesma leva de conformidade, a **agenda nativa** (`model Booking`, módulo
`src/bookings/`) foi removida. Ela guardava `clientName`, `clientWhats` e `note` — o
nome, o telefone e a **descrição do problema jurídico** de quem procurava um advogado —
no Postgres da plataforma.

O que decidiu a questão foi descobrir que **nenhuma tela a usava**: perfis com
`schedulingMode = "native"` já caíam para `"whatsapp"` na leitura (`resolveSchedulingMode`).
Os endpoints seguiam de pé e gravariam dado de terceiro sem aviso de privacidade, sem
prazo de retenção e sem ninguém olhando. Risco puro, valor zero.

Hoje o contato **não passa por nós**: o assistente e o formulário montam a mensagem e
ela sai do aparelho do visitante direto para o WhatsApp do advogado. Isso deixou a
Política de Privacidade mais simples *e* verdadeira — o que antes era "atuamos apenas
como meio de contato" (falso para a agenda nativa) agora é literal.

**Mantidas** as colunas `booking*` de `Profile` (grade, expediente, antecedência): são
preferências do próprio advogado, não têm dado de terceiro, e derrubá-las custaria
outra migração destrutiva sem ganho. Estão inertes e comentadas como tal.

**Deploy:** mais uma perda de tabela — `prisma db push` precisa de `--accept-data-loss`.
Se houver `Booking` gravado em produção, ele contém dado pessoal de terceiros: avalie
**descartar** em vez de exportar.
