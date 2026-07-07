# Plano futuro — Modelo próprio de IA por destilação do Claude

> **Status:** planejado, não implementado.
> **Objetivo:** ter um LLM local pequeno, barato e offline, especializado em redigir
> textos de perfil de advogado (bio e descrição de áreas) **dentro do Provimento
> 205/2021 da OAB**, com qualidade próxima à do Claude — sem depender de API paga em
> produção.

Este documento descreve a técnica, o pipeline e um roteiro por fases. Ele **não** substitui
o caminho de MVP (few-shot + banco de exemplos), que continua sendo a primeira escolha.

---

## 1. Quando ligar isto (e quando NÃO)

**Vale a pena quando:**

- O volume de gerações cresce e a conta da API vira custo relevante.
- Queremos rodar **100% offline / on-premise** (privacidade, sem enviar dados a terceiros).
- Queremos um **estilo fixo e consistente** — o "jeito advoc.me" de escrever.
- Latência e previsibilidade importam mais que flexibilidade máxima.

**NÃO vale (ainda) quando:**

- Estamos no MVP e o volume é baixo → **few-shot no prompt + banco de exemplos (RAG)**
  entrega ~90% do resultado com uma fração do esforço. Ver [§8](#8-alternativas-mais-baratas-fazer-primeiro).
- Não temos GPU. Fine-tuning em CPU é inviável na prática.

> Regra de ouro: **destilar é otimização, não pré-requisito.** Só entra depois que o
> produto provou tração e o custo/latência/privacidade justificarem.

---

## 2. A técnica, em uma frase

**Destilação teacher–student:** o Claude (professor) gera milhares de exemplos de
resposta ideal; um modelo pequeno (aluno, ex.: `llama3.2:3b`) é **ajustado (fine-tuned)**
para imitar esse comportamento naquela tarefa estreita.

```
Claude gera dataset  →  fine-tune (LoRA) no llama  →  modelo novo  →  avalia  →  repete
```

Pontos que mudam tudo (e costumam confundir):

1. **Não é aprendizado ao vivo.** O modelo servido pelo Ollama não aprende conversando.
   Aprender = uma etapa **offline** de treino que produz **pesos novos**.
2. **"Perfeito" não existe.** Um 3B tem teto de capacidade. A meta é ficar **excelente na
   tarefa estreita**, não onisciente. Vale a lei do retorno decrescente.
3. **O Claude entra como gerador de dados e como juiz** — não injeta conhecimento
   diretamente no modelo.

Vocabulário útil:

| Termo | O que é |
|---|---|
| **SFT** (Supervised Fine-Tuning) | Treinar em pares `(prompt, resposta ideal)`. É a base. |
| **LoRA / QLoRA** | Fine-tuning barato: treina só uns "adaptadores" pequenos, não o modelo inteiro. QLoRA = LoRA em 4-bit (cabe em GPU modesta). |
| **Destilação** | Usar um modelo forte (Claude) para gerar os dados/rótulos do treino. |
| **DPO** | Treinar com pares "resposta boa vs. ruim" — refina preferências e tom. |
| **RLAIF** | Um modelo-juiz (Claude) dá nota; usa-se isso como sinal de treino. Avançado. |
| **Eval** | Suíte de avaliação que mede se o modelo melhorou de verdade. |

---

## 3. Arquitetura do pipeline

```
                    ┌───────────────────────────────────────────────┐
                    │  1. GERAÇÃO DE DATASET (Claude, offline)        │
                    │  - variações de palavras-chave × áreas × tom    │
                    │  - Claude escreve a "resposta ideal"            │
                    │  - filtro de conformidade OAB (checkCompliance) │
                    │  → dataset.jsonl                                │
                    └───────────────────────────────────────────────┘
                                         │
                    ┌───────────────────────────────────────────────┐
                    │  2. TREINO (LoRA/QLoRA, GPU)                     │
                    │  - Unsloth / axolotl / LLaMA-Factory            │
                    │  - base: llama3.2:3b (ou qwen2.5:3b)            │
                    │  → adaptador LoRA                               │
                    └───────────────────────────────────────────────┘
                                         │
                    ┌───────────────────────────────────────────────┐
                    │  3. EMPACOTAMENTO                                │
                    │  - merge LoRA → export GGUF                     │
                    │  - Modelfile → `ollama create advocme-bio`     │
                    └───────────────────────────────────────────────┘
                                         │
                    ┌───────────────────────────────────────────────┐
                    │  4. AVALIAÇÃO (Claude como juiz + regras OAB)   │
                    │  - conformidade, tom, fidelidade às keywords   │
                    │  - compara vs. baseline (prompt+few-shot)      │
                    └───────────────────────────────────────────────┘
                                         │
                    ┌───────────────────────────────────────────────┐
                    │  5. DEPLOY                                       │
                    │  - AI_MODEL=advocme-bio no backend NestJS      │
                    │  - AI_PROVIDER=ollama (já suportado)           │
                    └───────────────────────────────────────────────┘
```

---

## 4. Dataset — o que mais importa

A qualidade do modelo final é ~80% o dataset. Metas iniciais:

- **Quantidade:** começar com **500–2.000** exemplos. Para tarefa estreita, isso já move
  o ponteiro. Escalar depois se a eval pedir.
- **Diversidade:** cobrir muitas áreas do Direito × conjuntos de palavras-chave × nuances
  de tom (mais sóbrio, mais acolhedor) × os dois formatos (`bio` e `area`).
- **Conformidade garantida:** todo exemplo gerado passa pelo `checkCompliance()`
  (`backend/src/oab/compliance.ts`); qualquer bloqueio é descartado ou regenerado.
  Assim o modelo aprende **só com material OAB-safe**.
- **Negativos (para DPO, fase 2):** guardar também versões "ruins" (mercantilista, promessa
  de resultado) rotuladas como piores — ensina o modelo a evitar.

### Formato sugerido (JSONL, estilo chat)

```jsonl
{"messages":[
  {"role":"system","content":"Você escreve bios de apresentação para páginas de perfil de advogados brasileiros. Tom sóbrio, ético, factual e acolhedor. Português do Brasil. Sem promessas de resultado, sem comparações de mercado e sem apelos de venda. Não mencione clientes ou casos específicos. Responda apenas com o texto final."},
  {"role":"user","content":"Escreva, em primeira pessoa, a bio de apresentação de Marina Sales, que é advogada no Brasil. Atua nas áreas: divórcio, guarda, pensão alimentícia, mediação. No máximo 3 frases, sem emojis."},
  {"role":"assistant","content":"Sou Marina Sales, advogada dedicada ao Direito de Família, com atuação em divórcio, guarda, pensão alimentícia e mediação. Meu trabalho une técnica e escuta para orientar cada pessoa sobre seus direitos e os caminhos possíveis. Busco uma condução clara e acolhedora em cada etapa."}
]}
```

> O `system` e o formato do `user` já são **exatamente** os que usamos em produção
> (`frontend/src/lib/localAi.ts` e `backend/src/ai/ai.service.ts`). Manter o mesmo formato
> no treino evita drift entre treino e uso.

### Esboço do gerador (destilação via Claude)

```
para cada (área, conjunto_de_keywords, tom) em combinações:
    prompt = montar_prompt(área, keywords, tom)
    ideal  = claude.generate(system=OAB_SYSTEM, user=prompt)   # o "professor"
    if checkCompliance(ideal) tem bloqueio:  regenerar/descartar
    else: append({prompt, ideal}) em dataset.jsonl
```

Roda uma vez, offline. Custo de API concentrado aqui (algumas dezenas de dólares no máximo
para milhares de exemplos), não em produção.

---

## 5. Treino — ferramentas e receita

| Ferramenta | Nota |
|---|---|
| **Unsloth** | Mais rápido/leve para LoRA em modelos pequenos; ótimo para 3B em GPU modesta. Recomendado para começar. |
| **axolotl** | Configurável por YAML, bem documentado. |
| **LLaMA-Factory** | UI + muitos modelos; bom para experimentar. |
| **transformers + PEFT** | Baixo nível, controle total. |

Receita inicial (QLoRA):

- Base: `llama3.2:3b` (ou `qwen2.5:3b`, costuma ir melhor em PT-BR — testar os dois).
- 4-bit (QLoRA), LoRA rank 16–32, 1–3 épocas, LR ~2e-4.
- Early stopping pela eval (§7) para não "decorar" (overfitting).

---

## 6. Empacotamento para o Ollama

```bash
# 1. merge do adaptador LoRA no modelo base e export para GGUF (via llama.cpp / Unsloth)
#    → advocme-bio.gguf

# 2. Modelfile
cat > Modelfile <<'EOF'
FROM ./advocme-bio.gguf
PARAMETER temperature 0.6
PARAMETER num_predict 260
SYSTEM """Você escreve bios e descrições de áreas para páginas de perfil de advogados brasileiros. Tom sóbrio, ético, factual e acolhedor. Português do Brasil. Sem promessas de resultado, sem comparações de mercado e sem apelos de venda. Não mencione clientes ou casos específicos. Responda apenas com o texto final."""
EOF

# 3. registra no Ollama
ollama create advocme-bio -f Modelfile
```

Deploy no backend é **trocar uma variável** (já suportado em `backend/src/ai/ai.service.ts`):

```env
AI_PROVIDER=ollama
AI_MODEL=advocme-bio
```

Zero mudança de código de produto.

---

## 7. Avaliação — como saber se ficou melhor

Sem eval, "acurácia subindo" é achismo. Suíte mínima:

1. **Conformidade OAB (objetiva):** rodar `checkCompliance()` em N saídas → % sem bloqueio.
   Meta: ≥ 99%.
2. **Fidelidade às keywords:** a bio menciona os temas pedidos? (checagem simples de termos).
3. **Tom / qualidade (LLM-judge):** o Claude dá nota 1–5 (sobriedade, clareza, naturalidade)
   comparando `modelo treinado` vs. `baseline prompt+few-shot`, **às cegas**.
4. **Conjunto de regressão fixo:** ~50 casos "de ouro" que rodam a cada iteração.

Só promove o modelo se ele **empatar ou vencer** o baseline na maioria das dimensões.

---

## 8. Alternativas mais baratas (fazer PRIMEIRO)

Antes de qualquer treino, esgotar estes — geralmente já bastam:

1. **Few-shot no prompt:** injetar 2–3 bios aprovadas como exemplo dentro do `OAB_SYSTEM`.
   O modelo copia o estilo na hora, sem treino. **Maior ROI imediato.**
2. **Banco de exemplos / RAG:** guardar as bios que o advogado aprovou; a cada geração,
   recuperar as 2–3 mais parecidas (por área/keywords) e usar como few-shot dinâmico.
   Melhora com o uso, sem tocar nos pesos.

> Estes dois já reaproveitam o `checkCompliance()` e o formato de prompt atuais. O
> fine-tuning só entra quando eles não forem mais suficientes.

---

## 9. Roadmap por fases

| Fase | Entrega | Pré-requisito |
|---|---|---|
| **0 — Baseline** | Few-shot + banco de exemplos (RAG). Medir qualidade. | Nenhum (parte já pronta) |
| **1 — Dataset** | Gerador de destilação (Claude → `dataset.jsonl`), com filtro OAB. Suíte de eval. | Fase 0 medida |
| **2 — SFT/LoRA** | Primeiro fine-tune (QLoRA) + comparação vs. baseline. | GPU + dataset |
| **3 — Empacotar** | GGUF + Modelfile + `advocme-bio` no Ollama. Trocar `AI_MODEL`. | Fase 2 aprovada na eval |
| **4 — DPO (opcional)** | Refino com pares bom/ruim para apertar tom e conformidade. | Fase 3 em produção |
| **5 — Loop contínuo** | Realimentar o dataset com bios aprovadas em produção; re-treinar periodicamente. | Volume real |

---

## 10. Riscos e cuidados

- **Overfitting:** dataset pequeno/pouco diverso → modelo repetitivo. Mitigar com diversidade
  e early stopping.
- **Drift treino↔produção:** manter **o mesmo** `system`/formato de prompt no treino e no uso.
- **Conformidade não é garantida pelo treino:** manter o `checkCompliance()` como
  **guarda-corpo em runtime** (fonte da verdade antes de publicar), mesmo com modelo treinado.
- **Licenças:** conferir a licença da base (Llama 3.2 / Qwen 2.5) para uso comercial.
- **Privacidade:** se usar bios reais de clientes/advogados no dataset, tratar como dado
  sensível (anonimizar, consentimento).

---

## 11. Referências de código já existentes no projeto

- `backend/src/ai/ai.service.ts` — já tem `AI_PROVIDER=ollama|anthropic` e `AI_MODEL`.
  Trocar para o modelo destilado é só mudar env.
- `backend/src/oab/compliance.ts` / `frontend/src/lib/oab.ts` — checagem OAB, reutilizada
  na geração do dataset, na eval e como guarda-corpo em runtime.
- `frontend/src/lib/localAi.ts` — `OAB_SYSTEM` e formato de prompt de referência (usar
  idêntico no dataset).

---

**TL;DR:** a ideia (destilar o Claude para um modelo local barato e offline) é sólida e
totalmente factível. O caminho é *dataset → LoRA → GGUF no Ollama → trocar uma env*. Mas
primeiro esgotar **few-shot + RAG**, que resolvem o MVP com muito menos esforço. Fine-tune
é a fase de escala, não de largada.
