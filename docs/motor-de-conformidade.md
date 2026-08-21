# Motor de Conformidade OAB

Guarda-corpo que impede publicidade advocatícia irregular (Provimento 205/2021 do
CFOAB + Código de Ética e Disciplina). O motor **não é aconselhamento jurídico** — é
uma heurística que reduz violações óbvias e **explica por quê**, para o advogado
corrigir antes de publicar.

## Arquitetura

O motor é dividido em **dados** (regras/regex) e **lógica** (avaliação), espelhado nos
dois pacotes:

| Papel | Frontend | Backend |
|---|---|---|
| Regras (dados) | `frontend/src/lib/oab.rules.ts` | `backend/src/oab/oab.rules.ts` |
| Motor (lógica) | `frontend/src/lib/oab.ts` | `backend/src/oab/compliance.ts` |
| Cobertura (o que é conferido) | `publicTexts` em `oab.ts` | `publicTexts` em `compliance.ts` |
| Testes | `oab.spec.ts`, `publicTexts.spec.ts`, `oabAcentos.spec.ts` | `oab.rules.spec.ts` |

- **Frontend** → feedback imediato no editor (não confiável isoladamente; roda no cliente).
- **Backend** → **fonte da verdade**: bloqueia a publicação de texto irregular
  (`ProfilesService.update`) e revalida a saída da IA (`AiService.generate`).

### O que é conferido (`publicTexts`)

A lista do que passa pelo motor é única e vive ao lado da lógica: frase de
apresentação, bio, observação de atendimento, nome e descrição de cada área,
pergunta e resposta do FAQ, legenda do vídeo, abertura do assistente e nome no
rodapé. **Campo público novo entra nessa lista** — `publicTexts.spec.ts` reprova se
algum sair dela.

Até 2026-08-21 a cobertura era implícita e desigual: o backend conferia bio, descrição
de área e FAQ; o editor avisava só na bio. A **frase de apresentação** — a linha mais
visível do perfil depois do nome — não era conferida em lugar nenhum.

### Duas armadilhas conhecidas de regex

1. **Fronteira de palavra é ASCII.** `\b` não enxerga limite antes de letra acentuada,
   então um ramo de alternância que COMEÇA (ou termina) com acento nunca casa. Foi
   assim que `êxito garantido` ficou desligado por três revisões. Use lookaround com
   `\p{L}` e a flag `u`. `oabAcentos.spec.ts` lê o fonte das regexes e reprova o
   padrão — acento no meio da palavra é inofensivo e não gera alarme.
2. **`\w` também é ASCII.** `promoç\w+` nunca casa "promoção", porque o `ã` não é
   `\w`. Escreva as terminações à mão (`promo(?:ção|ções|cional)`).

### Termo vedado ≠ matéria jurídica

`honorários`, `parcelamento`, `descontos` e `preços` aparecem tanto em oferta
comercial quanto em NOME DE MATÉRIA ("arbitramento de honorários", "parcelamento
tributário", "descontos indevidos em benefício"). As regras exigem contexto de oferta
antes de bloquear — travar a publicação de uma área de atuação real é defeito nosso,
não conformidade.

Toda a regex vive **exclusivamente** nos arquivos `*.rules.ts` — não há regex de
conformidade espalhada pelo resto do código.

### Por que dois arquivos-espelho (e não um pacote compartilhado)?

Frontend e backend são pacotes independentes (build, deps e `.git` próprios). Um pacote
compartilhado exigiria monorepo/workspace — mudança de arquitetura arriscada. Em vez
disso, mantemos os dois `oab.rules.ts` **idênticos** e garantimos a paridade com uma
trava automática (abaixo). Evoluir para pacote compartilhado fica como opção futura.

## Formato de um apontamento (`ComplianceIssue`)

Cada violação produz um objeto que diz **exatamente** o que houve e como corrigir:

```ts
{
  ruleId:      'promise-result',            // regra que disparou
  category:    'promise',                   // categoria da vedação
  severity:    'block',                     // 'block' impede publicar | 'warn' alerta
  version:     'Prov. 205/2021',            // versão da política aplicada
  matchedText: '100% garantido',            // trecho que casou
  explanation: 'O Provimento 205/2021 ...', // POR QUÊ é vedado
  suggestion:  'Descreva sua atuação ...',  // COMO corrigir
  // aliases de retrocompatibilidade:
  term:        '100% garantido',            // = matchedText  (@deprecated)
  reason:      'Promessa/garantia ...',     // motivo curto   (@deprecated)
}
```

## Versionamento e monitor normativo

- `POLICY_VERSION` — versão do Provimento vigente (ex.: `Prov. 205/2021`).
- `RULESET_REV` — revisão interna do conjunto de regras. **Incrementar a cada mudança.**
- `policyOutdated(policyRevChecked)` — `true` quando um perfil foi conferido sob uma
  revisão anterior. O editor então reavalia e avisa o advogado (`PolicyUpdateBanner`),
  e a publicação recarimba `policyRevChecked = RULESET_REV`.

A tabela `PolicyVersion` (Prisma) mantém o histórico das versões da política.

## Categorias

`promise` · `comparison` · `commercialization` · `price` · `discount` · `free-bait` ·
`urgency` · `cta` · `testimonial` · `secrecy` · `oab-misuse` · `giveaway` ·
`paid-ranking`. Cada uma traz rótulo e base legal em `CATEGORIES`.

## Como adicionar ou ajustar uma regra

1. Edite **os dois** `oab.rules.ts` (frontend e backend) de forma idêntica.
2. Preencha todos os campos da `Rule`: `id`, `category`, `severity`, `version`, `test`,
   `reason`, `explanation`, `suggestion`, `examplesForbidden[]`, `examplesAllowed[]`.
3. Cubra a regra com exemplos reais (proibidos → devem sinalizar; permitidos → não
   podem dar falso-positivo). A suíte já valida automaticamente os exemplos declarados.
4. **Incremente `RULESET_REV`** (nos dois arquivos).
5. Rode `npm test` nos dois pacotes. A trava de paridade vai falhar mostrando o novo
   fingerprint — copie-o para `docs/oab-ruleset.lock`.

### Dica de regex (acentos)

O `\b` do JavaScript é ASCII: **não** reconhece letra acentuada como caractere de
palavra. Para termos iniciados/terminados por acento (ex.: "Últimas", "único"), use
fronteiras unicode `(?<![\p{L}])…(?![\p{L}])` com a flag `u` — ver as regras
`urgency-appeal` e `superlative-comparison`.

## Trava de paridade (front ↔ back)

`computeRulesetFingerprint()` gera uma impressão digital determinística do conjunto de
regras (`id|categoria|severidade` de cada regra, ordenado, + versão + revisão). O valor
canônico fica em **`docs/oab-ruleset.lock`**. Os testes de **cada** pacote recomputam o
fingerprint e comparam com o lock:

- Editou um lado e esqueceu o outro → o fingerprint diverge do lock → **teste falha**.
- Como ambos precisam bater com o **mesmo** lock, os dois conjuntos são forçados a
  permanecer idênticos.

## Onde o motor é aplicado

- `ProfilesService.update` — bloqueia publicar bio/áreas com issue `block`; registra
  tentativas em `AuditLog` (`action: 'blocked'`).
- `AiService.generate` — revalida o texto gerado; se escorregar, cai no template seguro.
- Editor (frontend) — `MarginNotes` (comentários à margem, com sugestão), `InfoTip`
  (orientação por campo), `ReviewStep` (revisão final) e o gate do botão Publicar.

## Testes

```bash
# frontend
cd frontend && npm test
# backend
cd backend && npm test
```

A suíte cobre cada categoria com exemplos reais (proibidos e permitidos), a forma do
apontamento, o status agregado, o monitor normativo e a trava de paridade.
