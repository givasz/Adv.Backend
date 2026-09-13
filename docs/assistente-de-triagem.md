# Assistente de triagem

> Implementado em 13/09/2026. Plano **Max**. Roda dentro do assistente virtual
> que já existia (Pro), antes da escolha de dia e horário.

## O que é, em uma frase

Uma recepção digital configurável: **o advogado escreve as perguntas**, o
assistente as faz na ordem, organiza as respostas e entrega tudo no WhatsApp
dele. Quem avalia, decide e confirma é o advogado.

## O que NÃO é, e por quê

Não é um chatbot jurídico. Não há IA em nenhum ponto deste caminho — nem para
interpretar a resposta, nem para classificar o caso, nem para sugerir uma área.
A conversa é um roteiro determinístico montado a partir de dados do perfil.

O Provimento 205/2021 (CFOAB) e a Cartilha do Comitê de Marketing admitem o
chatbot para **facilitar a comunicação, encaminhar primeiras informações e
coletar dados**, e vedam usá-lo para **responder consulta jurídica** de quem não
é cliente. Essa fronteira é a arquitetura, não um aviso colado na tela: não
existe função no código capaz de opinar sobre um caso.

Quando o visitante pede análise ("tenho direito?", "posso processar?"), o
assistente responde que a avaliação é do advogado e segue com a próxima
pergunta — ver `pedeOrientacaoJuridica` em `frontend/src/lib/triagem.ts`.

## Onde cada coisa mora

| Assunto | Arquivo |
|---|---|
| Formato, tetos, normalização | `frontend/src/lib/triagem.ts` ⇄ `backend/src/triagem.ts` |
| Detector de pedido de dado sensível | `frontend/src/lib/triagemDados.ts` ⇄ `backend/src/triagem-dados.ts` |
| Casos compartilhados pelos dois lados | `frontend/src/lib/triagem.casos.json` |
| Modelos e vocabulário do editor | `frontend/src/lib/triagemModelos.ts` |
| Tela do advogado | `frontend/src/components/editor/TriagemCard.tsx` |
| Conversa do visitante | `frontend/src/components/profile/AssistantChat.tsx` |
| Ensaio do próprio assistente | `frontend/src/pages/TestarAssistentePage.tsx` (`/assistente/testar`) |
| Portão de plano (fonte única) | `canUseTriagem` em `*/plans.ts` |
| Leitura/escrita e portão no servidor | `backend/src/profiles/profiles.service.ts` |

Colunas novas em `Profile`: `triageEnabled` (bool) e `triageQuestions` (JSON).
Nenhuma tabela nova.

## Retenção: não há

**Não existe coluna, rota ou tabela com resposta de visitante**, e não deve
passar a existir. O que a pessoa responde vive na memória da aba aberta e vira
uma mensagem montada no aparelho dela, que sai dali direto para o WhatsApp do
advogado. O advoc.me não recebe, não guarda e não tem como ler.

É a mesma decisão que removeu a agenda-calendário em 21/08/2026. O histórico do
atendimento é o WhatsApp do advogado — e é isso que a Política de Privacidade,
o aviso do rodapé da conversa e a home dizem.

## As três camadas contra coleta indevida

1. **Educação.** A orientação aparece na tela ANTES da primeira pergunta, e os
   seis modelos já vêm sem nenhum pedido de dado pessoal (há teste travando
   isso: `triagemModelos.spec.ts`).
2. **Conferência com reescrita pronta.** Cada enunciado passa por
   `conferirPergunta`. CPF, RG, documento para anexar, saúde, renda, endereço
   completo, dado de terceiro e número de processo geram **aviso** — cada um tem
   uso legítimo em algum escritório, e quem decide é o profissional.
3. **Recusa do servidor.** Senha, código de confirmação, cartão e conta bancária
   são **bloqueio**: não existe triagem inicial legítima que precise disso, e uma
   página de advogado pedindo "o código que chegou no seu SMS" é um golpe pronto.

"processo" e "documento" sozinhos nunca disparam nada: são vocabulário normal de
uma triagem, e barrá-los seria a plataforma discutindo redação com advogado.

## O que a plataforma NÃO promete

Está escrito na própria tela (`LIMITES_DA_TRIAGEM`): a triagem não é consultoria
jurídica, a configuração das perguntas é responsabilidade do advogado, e o
advoc.me não garante que uma configuração específica seja adequada a toda
situação profissional ou disciplinar. Vale aqui a regra de `SEGURANCA.md`: **a
plataforma nunca atesta a conformidade de um perfil.**

## Plano e compatibilidade

- **Free** — sem agendamento e sem triagem.
- **Pro** — o assistente de agendamento inteiro, como sempre foi.
- **Max** — o assistente passa a fazer as perguntas do advogado antes.
- **Escritório** — herda: a sociedade opera em `premium` e os perfis dos membros
  ativos passam a valer nesse tier. O assistente da SOCIEDADE (área → advogado →
  período) não foi tocado — ele encaminha, e a triagem do advogado escolhido
  continua no perfil dele.

Descer de plano **esconde, nunca apaga**: fora do Max as colunas não entram no
`update` e o objeto some da resposta da API. Quem voltar reencontra as perguntas
montadas — a mesma regra do vídeo, do cartão impresso e da marca.

## Deploy

As duas colunas são aditivas e têm padrão: `prisma db push` na VPS resolve, **sem**
`--accept-data-loss`. Nada a migrar, nada a preencher.
