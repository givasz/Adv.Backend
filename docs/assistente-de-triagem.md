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

## Perguntas que só abrem para uma resposta (ramificação)

Uma pergunta pode ser **só de quem deu uma resposta específica** numa pergunta
anterior: "Você ainda trabalha nessa empresa?" só aparece para quem respondeu
"Trabalhista". Quem respondeu outra coisa — ou pulou aquela pergunta — não a vê
e segue para a seguinte. Sem ligação, a pergunta é de todo mundo, que é como toda
triagem começa.

O dado mora na pergunta de destino (`condicao: { pergunta, opcoes }`): depende de
**uma** pergunta, e basta **uma** das respostas marcadas. Encadear resolve o
resto — a pergunta que depende de outra dependente só abre com as duas respostas.
Múltipla escolha também serve de origem: basta uma das marcadas.

Além disso, cada resposta pode **encerrar a triagem** (`encerra: true` na opção):
quem a dá vai direto para os horários (ou para o envio, sem grade). Múltipla
escolha não encerra — a pessoa pode ter marcado junto outra resposta que abre uma
pergunta, e não há desempate honesto.

Até 13/09/2026 o mecanismo era outro: a resposta **pulava** para uma pergunta
mais à frente (`proxima`). Pular não impedia quem deu outra resposta de chegar à
mesma pergunta depois, e não era isso que o advogado queria dizer. Nenhum perfil
em produção tinha salto gravado quando a troca foi feita, então não há conversão:
o normalizador simplesmente não lê mais `proxima`.

A conversa anda assim (`proximaPergunta`): se a resposta dada encerra, acabou;
senão, a próxima é a primeira pergunta seguinte cuja condição foi atendida pelo
que já foi respondido (`RespostasDoCaminho`: ids das respostas tocadas, nunca o
texto).

### Por que um loop é impossível

A regra é uma só: **uma pergunta só depende de pergunta ANTERIOR**. A conversa só
anda para frente e nunca espera por uma resposta futura — não é um detector de
ciclos, é impossibilidade estrutural: o índice só cresce, então a conversa chega
ao fim em no máximo N passos, para qualquer configuração que alguém consiga
gravar.

Ela é aplicada em três lugares, de fora para dentro:

1. **A tela não oferece** outra coisa: `fontesPossiveis` só lista perguntas
   anteriores com resposta para escolher, e o fluxograma só oferece ligar uma
   resposta a perguntas seguintes. Uma pergunta também não sobe acima daquela de
   que depende (`podeTrocarComAProxima`).
2. **O normalizador derruba** o que chegar assim mesmo — segunda passagem de
   `normalizarTriagem` (condição para pergunta posterior, para si mesma, para o
   nada, para pergunta sem opções ou para resposta que não existe), que vale para
   corpo forjado também.
3. **A conversa reconfere** na hora de andar (`proximaPergunta` só olha para
   frente).

Há prova disso em `triagem-caminhos.spec.ts` (espelhado nos dois lados): mil
triagens com ligações sorteadas — inclusive para pergunta posterior, para a
própria pergunta e para ids inexistentes — são normalizadas e percorridas por
TODOS os caminhos possíveis (múltipla escolha com todas as combinações). Nenhuma
deixa de terminar, e o conjunto de perguntas alcançáveis bate com o percurso.

Ligação que vira inválida (porque o advogado apagou a pergunta de origem ou
trocou o tipo dela) some em silêncio, e o fluxograma mostra na hora o desenho
novo. No editor, a condição ainda sem resposta escolhida fica (é o advogado no
meio do gesto); ao gravar, ela cai.

### Pergunta que ninguém alcança

O defeito clássico de todo formulário com caminhos: a pergunta está na lista,
parece no ar, e nunca é feita a ninguém — porque só abre com uma resposta que
encerra a triagem, ou vem depois de uma pergunta em que toda resposta encerra.
`perguntasAlcancaveis` anda por todos os caminhos (com memória de estados e um
teto; estourado, devolve todas) e o editor marca as órfãs — avisa, não bloqueia.

## O fluxograma, no lugar da prévia do celular

Na seção da triagem, a coluna da direita do editor (e a aba "Fluxograma" no
celular) não mostra o perfil: mostra o **caminho da conversa**
(`MapaDaTriagem`). A pergunta que o advogado faz ali é "por onde a conversa
passa?", e uma lista numerada não responde quando há perguntas que só abrem
para uma resposta.

- Caixa em vinho: uma pergunta do advogado, com as respostas embaixo. Cada
  resposta diz o que abre ("→ 3") e se encerra.
- Losango colorido: um trecho que só abre para quem deu aquela resposta. A mesma
  cor marca a resposta na caixa de cima — é o que liga as duas sem linha cruzando
  a tela.
- Tracejado à direita do trecho: quem respondeu outra coisa pula.
- Trechos se aninham quando a pergunta de dentro depende de outra do trecho —
  ela só pode ser feita se a de fora foi, então desenhá-la dentro é a verdade
  sobre o caminho.
- Antes e depois: a abertura com o aviso de segurança, e os passos que o
  assistente faz sozinho (dia e horário, formato, nome, envio).

**O fluxograma também edita.** Tocar numa resposta abre, logo abaixo da caixa,
as perguntas seguintes para marcar ("quem responder assim recebe…") e o
"encerra a triagem aqui". É o mesmo dado que "Quem recebe esta pergunta", no
editor de cada pergunta, mexe — `ligarResposta` é a fonte única dos dois gestos.

A estrutura (caixas, trechos, aninhamento, numeração pela lista do editor) sai de
`mapaDaTriagem`, que usa as mesmas funções da conversa; o componente só desenha.
Testes em `triagemMapa.spec.ts`.

Ao lado, **Testar meu assistente** (`/assistente/testar`) abre a conversa de
verdade, com o perfil gravado e sem abrir o WhatsApp no fim.

## Perguntas que o assistente faz sozinho: o advogado pode tirar

Depois das perguntas do advogado, o assistente fazia sempre três perguntas
próprias: **dia e horário**, **presencial ou online** (quando o perfil atende dos
dois jeitos e a triagem não pergunta) e **como posso te chamar** (quando a
triagem não pergunta). Desde 13/09/2026 o advogado tira qualquer uma delas no
fluxograma (o × do passo), e devolve pelo "Devolver" que fica logo abaixo, com o
efeito escrito:

- **sem dia e horário** — o pedido chega como pedido de CONTATO, mesmo com a grade
  aberta (o mesmo caminho da triagem num perfil sem grade);
- **sem formato** — a mensagem chega sem "Formato:" (nunca um formato adivinhado);
- **sem nome** — a mensagem chega sem "Nome:"; o horário escolhido é reconferido
  no fecho, que é onde o nome o reconferia.

**Não saem:** a abertura com o aviso para não enviar documentos, senhas ou dados
bancários (sem ela a pessoa escreve sem saber o que não mandar) e o envio pelo
WhatsApp (sem ele nada chega). Não há botão para elas, e o normalizador só aceita
`horario`, `formato` e `nome` (`semEtapas`, ausente quando nada foi tirado).

Só vale com a triagem ATIVA (`etapaNaConversa`): sem triagem o assistente é um
agendador, e agendador sem dia e horário não teria o que agendar.

## Onde cada coisa mora

| Assunto | Arquivo |
|---|---|
| Formato, tetos, normalização, caminho da conversa | `frontend/src/lib/triagem.ts` ⇄ `backend/src/triagem.ts` |
| Prova de que a conversa termina | `triagemCaminhos.spec.ts` ⇄ `triagem-caminhos.spec.ts` |
| Fluxograma e ligações (modelo) | `mapaDaTriagem`, `ligarResposta` em `frontend/src/lib/triagem.ts` · `triagemMapa.spec.ts` |
| Detector de pedido de dado sensível | `frontend/src/lib/triagemDados.ts` ⇄ `backend/src/triagem-dados.ts` |
| Casos compartilhados pelos dois lados | `frontend/src/lib/triagem.casos.json` |
| Modelos e vocabulário do editor | `frontend/src/lib/triagemModelos.ts` |
| Tela do advogado | `frontend/src/components/editor/TriagemCard.tsx` |
| Fluxograma (desenho) | `frontend/src/components/editor/MapaDaTriagem.tsx` |
| Conversa do visitante | `frontend/src/components/profile/AssistantChat.tsx` |
| Ensaio do próprio assistente | `frontend/src/pages/TestarAssistentePage.tsx` (`/assistente/testar`) |
| Portão de plano (fonte única) | `canUseTriagem` em `*/plans.ts` |
| Leitura/escrita e portão no servidor | `backend/src/profiles/profiles.service.ts` |

Colunas em `Profile`: `triageEnabled` (bool), `triageQuestions` (JSON) e
`triageSkipSteps` (JSON, as etapas embutidas tiradas — desde 13/09/2026). Nenhuma
tabela nova — a ligação e o "encerra" moram dentro do JSON das perguntas.

Cada opção de resposta tem **id próprio** (`{ id, texto, encerra? }`), e não é o
texto que serve de chave: o advogado renomeia uma opção o tempo todo, e com
chave de texto a pergunta ligada a ela se soltaria a cada correção de digitação.
As listas fixas ("Sim/Não", "Presencial/Online") são postas pelo normalizador com
ids estáveis — assim ligar uma resposta é um mecanismo só, e não três. No perfil
que só atende de um jeito, a pergunta de formato não é feita, mas a resposta
conhecida vale para as ligações.

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
montadas — a mesma regra do vídeo, do cartão impresso e da marca. Fora do Max, o
fluxograma aparece sob o cadeado com uma triagem de exemplo.

## Deploy

As colunas são aditivas e têm padrão: `prisma db push` na VPS resolve, **sem**
`--accept-data-loss`. Nada a migrar, nada a preencher. `triageSkipSteps` entrou em
13/09/2026 do mesmo jeito (padrão `"[]"` = nenhuma etapa tirada). A troca de salto para
ligação (13/09/2026) não mexeu em schema — só no normalizador, que precisa subir
no backend ANTES do frontend (o front novo grava `condicao`, e o backend antigo a
jogaria fora).
