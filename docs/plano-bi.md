# Plano de BI — Power BI sobre a base do advoc.me

> Escrito em 28/08/2026. Companheiro de [plano-admin.md](plano-admin.md): a Fase 9
> daquele plano (L8 — "Nenhum número") entrega a **operação** dentro do painel;
> este documento entrega a **análise**, fora dele.

**A decisão em uma linha:** o Power BI lê um esquema `bi` de *views* no Postgres da
VPS, por um usuário só-leitura, através de um túnel SSH — sem abrir porta nova, sem
copiar tabela crua para a máquina de ninguém e sem um único dado de visitante.

---

## 1. Por que os dois — painel e Power BI — e onde fica a fronteira

Não é redundância. São perguntas de natureza diferente:

| | Painel admin (Fase 9) | Power BI |
| --- | --- | --- |
| Pergunta | "o que precisa da minha ação **hoje**?" | "o que está acontecendo com o negócio?" |
| Recorte | agora, fila, alerta | série histórica, coorte, cruzamento |
| Público | quem modera e atende | quem decide produto e preço |
| Vive em | tela do produto | arquivo `.pbix` na máquina do dono |

**A fronteira que impede divergência:** os dois leem as **mesmas views `bi.*`**. Se o
painel dissesse "412 publicados" e o relatório dissesse 419, o número perderia
serventia nos dois lugares — e ninguém descobriria qual estava certo. Uma fonte, duas
telas.

---

## 2. As perguntas que o relatório existe para responder

Não é "vamos ligar um BI e ver o que aparece". A lista abaixo é o escopo; o que não
responde a uma destas perguntas não entra no relatório.

**Quem são os clientes (advogados).**

1. Quantos somos, onde estão (UF e cidade), e isso está crescendo ou parou?
2. Que áreas de atuação dominam a base? Há UF onde uma área concentra?
3. Quanto tempo passa entre criar a conta e **publicar** o perfil? Quem nunca publica?
4. Quantos estão num escritório e quantos assentos comprados estão ociosos?

**Ativação e abandono.**

5. Da coorte que se cadastrou num mês, quanto por cento ainda edita o perfil 30, 60 e
   90 dias depois?
6. Onde o perfil para de crescer? (só bio? nunca colocou foto? nunca abriu FAQ?)
7. Quem subiu de plano, quem desceu, quem cancelou — e quanto tempo ficou.

**Uso — o que acontece na página pública.**

8. Visitas e contatos por dia, por hora do dia e por dia da semana.
9. Qual botão as pessoas usam: WhatsApp, agendar, assistente, e-mail, cartão, rede?
10. Taxa de contato (de cada 100 visitas, quantas viraram tentativa de falar).

**A pergunta que paga o resto — o que faz um perfil funcionar.**

11. A taxa de contato de quem **tem vídeo** é diferente da de quem não tem? E FAQ? E
    foto? E assistente ligado em vez de link externo? E número de áreas?

    É a única análise aqui capaz de mudar o produto: se perfis com FAQ recebem
    sistematicamente mais contato, o painel do advogado deveria empurrar FAQ antes de
    empurrar qualquer outra coisa — e a oferta do Pro passa a ter um argumento medido,
    não um argumento de marketing.

**Confiança e operação.**

12. Denúncias por motivo e por mês; quantas viram medida e quantas são descartadas.
13. Sanções aplicadas por degrau; contestações respondidas **dentro** dos 10 dias (ver
    [politica-de-sancoes.md](politica-de-sancoes.md) — silêncio derruba a medida, então
    esse número é risco jurídico, não vaidade).
14. Chamados de suporte por tipo e tempo até o encerramento.

**Dinheiro.**

15. Receita contratada por plano — hoje **simulada**, ver §3.

---

## 3. Três avisos que mudam o desenho (e não são detalhe)

**a) Ninguém está sendo cobrado.** `COBRANCA_ATIVA = false` em
`frontend/src/lib/planOffer.ts`. Um cartão de "MRR" mostrando R$ 8.400 hoje seria
ficção convincente — o pior tipo de número num painel. A página de receita nasce
rotulada **"receita contratada (cobrança desligada)"** e só perde o rótulo quando a
constante virar `true`.

**b) `Profile` não tem história.** O plano, o status e a UF são **sobrescritos** na
linha. Perguntar "quantos Pro tínhamos em junho" hoje é impossível: essa informação já
não existe em lugar nenhum (`BillingEvent` guarda eventos de cobrança, não o retrato do
dia, e a cobrança nem começou). Sem consertar isso, metade das perguntas de §2 só passa
a ter resposta *daqui para frente*. É o que motiva a Fase 2.

**c) Evento cru vive 400 dias.** `RETENCAO_EVENTOS_DIAS = 400`
(`backend/src/analytics/eventos.ts`) — escolhido para cobrir "este mês contra o mesmo
mês do ano passado". O expurgo é diário e definitivo. Se quisermos série de uso com
mais de 400 dias, o agregado **mensal** precisa ser gravado antes de o cru morrer.
Também é Fase 2.

---

## 4. O que o BI não vai fazer

Vedações de produto, não itens de backlog. Repetem as do painel porque um relatório é
exatamente o lugar onde elas seriam quebradas "só para ver".

- **Nenhum dado de visitante.** `LinkEvent` guarda perfil, tipo e instante — e nada
  mais, por decisão de 21/08/2026. Não existe visitante único, não existe funil por
  pessoa, não existe origem por indivíduo. Se um dia alguém pedir "só o IP para saber a
  cidade do visitante", a resposta é não: o visitante do perfil não é nosso usuário e
  muitas vezes procura advogado por um motivo que não contaria a terceiros.
- **Nenhum ranking de advogado que saia daqui.** Análise interna de "o que funciona" é
  agregada e serve para melhorar o produto. Ordenar advogados por desempenho e levar
  isso ao público é hierarquia entre profissionais — vedada pelo Prov. 205/2021 e já
  recusada no painel.
- **Nenhum dado pessoal desnecessário na camada `bi`.** Fora: e-mail, hash de senha,
  número de OAB, WhatsApp, telefone, texto de denúncia, texto de contestação, `payload`
  de cobrança, `ipFingerprint`, `userAgent`. O que identifica um advogado individual é
  assunto do painel, com `AdminAction` registrando quem olhou — não de um `.pbix` que
  ninguém audita.
- **Nenhuma publicação aberta.** O "Publicar na web" do Power BI torna o relatório
  público na internet, sem senha e indexável. Nunca.

---

## 5. Como o Power BI chega ao dado

### O caminho escolhido: túnel SSH + usuário só-leitura + views

O Postgres da VPS escuta em `127.0.0.1:5432` e o `ufw` só deixa entrar 22, 80 e 443
(ver [DEPLOY-VPS.md](../DEPLOY-VPS.md)). O SSH é chave-só, com `fail2ban`. Isso já é
uma porta segura — e é a única de que precisamos.

```
Power BI Desktop (Windows) → localhost:15432 → [túnel SSH] → VPS 127.0.0.1:5432
                                                             usuário bi_leitor
                                                             esquema bi (views)
```

Abrir o túnel, na máquina do dono:

```powershell
ssh -N -L 15432:127.0.0.1:5432 root@<ip-da-vps>
```

No Power BI: *Obter dados → Banco de dados PostgreSQL*, servidor `localhost:15432`,
banco `advocme`, usuário `bi_leitor`. **Importação**, não DirectQuery — o volume é
pequeno, e DirectQuery deixaria o relatório mudo toda vez que o túnel caísse.

### Por que não as alternativas

| Alternativa | Por que não |
| --- | --- |
| Abrir a 5432 no `ufw` | Porta de banco exposta é das coisas mais varridas que existem, e ganha zero: o túnel entrega o mesmo por uma porta que já está aberta. |
| Endpoint `/admin/bi` consumido pelo conector Web | O painel exige TOTP; o Power BI não faz TOTP. Sobraria um token permanente de leitura total — uma segunda porta de administração, com metade da vigilância. |
| Ler o `pg_dump` na máquina local | Passa a existir uma cópia integral do banco — com e-mails, hashes e denúncias — num notebook. Justamente o que a camada `bi` evita. |
| Restaurar o dump num Postgres local só para BI | Mesmo problema, com um banco a mais para esquecer desatualizado. |

### O usuário só-leitura

```sql
create role bi_leitor login password '<sorteada, guardada no gerenciador de senhas>';
revoke all on schema public from bi_leitor;
grant connect on database advocme to bi_leitor;
grant usage on schema bi to bi_leitor;
grant select on all tables in schema bi to bi_leitor;
alter default privileges in schema bi grant select on tables to bi_leitor;
```

O detalhe que faz isso funcionar: no Postgres, uma view roda com os privilégios do
**dono** dela. As views `bi.*` pertencem a `advocme`, então `bi_leitor` lê o resultado
delas **sem ter permissão nenhuma nas tabelas cruas**. Se alguém apontar o `psql` desse
usuário para `"User"` ou `"Session"`, leva `permission denied`. A minimização não
depende de disciplina — está no banco.

> Não usar `security_invoker = true` nessas views. É exatamente o que quebraria isso.

---

## 6. A camada `bi` — o SQL

No ar em [`backend/prisma/bi/bi.sql`](../backend/prisma/bi/bi.sql), versionado e aplicado com
`psql -f` depois de cada `prisma db push` que mexa nas colunas usadas aqui. O usuário
de leitura fica em [`bi_leitor.sql`](../backend/prisma/bi/bi_leitor.sql), que roda uma vez só.

### 6.1 Fuso horário — a armadilha

O Prisma mapeia `DateTime` para `timestamp(3)` **sem fuso**, e a VPS roda em UTC. Um
`date("createdAt")` cru joga tudo que acontece entre 21h e meia-noite de Brasília para
o dia seguinte, e desloca o gráfico "por hora" em três casas — o pico das 20h aparece
às 23h. O erro é discreto e constante: ninguém percebe, e toda conclusão sobre horário
sai errada.

A conversão tem **dois passos**, e pular o primeiro é o engano comum: primeiro declarar
que o valor guardado é UTC, depois trazê-lo para São Paulo.

```sql
create schema if not exists bi;

create or replace function bi.dia_local(ts timestamp) returns date
  language sql stable as
$$ select ((ts at time zone 'UTC') at time zone 'America/Sao_Paulo')::date $$;

create or replace function bi.hora_local(ts timestamp) returns int
  language sql stable as
$$ select extract(hour from ((ts at time zone 'UTC') at time zone 'America/Sao_Paulo'))::int $$;
```

### 6.2 `bi.dim_perfil` — quem são os clientes

Sem nome, sem e-mail, sem OAB, sem WhatsApp. O `slug` fica porque é público e é o que
permite ir do relatório para a página real quando algo chamar atenção.

```sql
create or replace view bi.dim_perfil as
select
  p.id                                    as perfil_id,
  p.slug,
  nullif(p.state, '')                     as uf,
  nullif(p.city,  '')                     as cidade,
  p.plan::text                            as plano_contratado,
  p."planStatus"::text                    as situacao_cobranca,
  p.published                             as publicado,
  p."moderationStatus"::text              as moderacao,
  p."schedulingMode"                      as modo_agendamento,
  p.theme                                 as tema,
  (p."avatarUrl" is not null)             as tem_foto,
  (p."videoUrl"  is not null)             as tem_video,
  (p.card     <> '')                      as tem_cartao,
  (p.bio      <> '')                      as tem_bio,
  (p.headline <> '')                      as tem_chamada,
  length(p.bio)                           as bio_caracteres,
  (select count(*) from "PracticeArea" a where a."profileId" = p.id) as areas,
  (select count(*) from "Faq"          f where f."profileId" = p.id) as perguntas,
  (select count(*) from "SocialLink"   s where s."profileId" = p.id) as redes,
  (fm.id is not null)                     as em_escritorio,
  fm."firmId"                             as escritorio_id,
  bi.dia_local(p."createdAt")             as cadastro_em,
  bi.dia_local(p."updatedAt")             as ultima_edicao_em,
  bi.dia_local(u."createdAt")             as conta_criada_em,
  (u."suspendedAt" is not null)           as conta_suspensa,
  (u."closedAt"    is not null)           as conta_encerrada
from "Profile" p
join "User" u on u.id = p."userId"
left join "FirmMembership" fm on fm."profileId" = p.id;
```

### 6.3 `bi.fato_evento_dia` — uso, agregado na origem

O Power BI nunca vê a linha crua de `LinkEvent`. A view já entrega somado por perfil,
dia, hora e tipo — o que reduz o volume em uma ou duas ordens de grandeza e torna
impossível reconstruir sequência de acessos a partir do `.pbix`.

```sql
create or replace view bi.fato_evento_dia as
select
  e."profileId"                as perfil_id,
  bi.dia_local(e."createdAt")  as dia,
  bi.hora_local(e."createdAt") as hora,
  e.kind                       as evento,
  (e.kind in ('whatsapp','agendamento','assistente','email','cartao')) as e_contato,
  count(*)                     as total
from "LinkEvent" e
group by 1, 2, 3, 4, 5;
```

> A lista de contato espelha `EVENTOS_DE_CONTATO` em `src/analytics/eventos.ts`.
> Espelho é dívida: entra na trava de paridade da Fase 1 (§12).

### 6.4 As demais views

| View | Grão | Serve à pergunta |
| --- | --- | --- |
| `bi.dim_escritorio` | 1 por escritório: UF, plano, assentos comprados, assentos **em uso**, criado em | 4 |
| `bi.fato_denuncia` | 1 por `Report`: perfil, motivo, status, resolução, aberto em, encerrado em, horas até encerrar. **Sem `details`, sem `reporterEmail`** | 12 |
| `bi.fato_sancao` | 1 por `AdminAction` de moderação: ação, tipo de alvo, dia. **Sem `reason`, `before`, `after`, `ip`** | 13 |
| `bi.fato_contestacao` | 1 por `Appeal`: alvo, medida, status, `respondeAte`, decidido em, **`dentro_do_prazo` booleano**. Sem o texto | 13 |
| `bi.fato_chamado` | 1 por `SupportTicket`: tipo, status, aberto/encerrado, horas até encerrar. Sem assunto, mensagem e `userAgent` | 14 |
| `bi.fato_conformidade` | 1 por `AuditLog`: perfil, ação, `complianceStatus`, versão da política, dia. **Sem `bioSnapshot`** | saúde do motor OAB |
| `bi.dim_area` | 1 por área declarada: perfil, rótulo cru, rótulo canônico (§6.5) | 2 |

### 6.5 O problema das áreas de atuação

`PracticeArea.label` é texto livre. "Direito de Família", "Familia", "familiar" e
"Família e Sucessões" são quatro linhas diferentes e um gráfico inútil. Sem
normalização, a pergunta 2 não tem resposta.

Solução barata e honesta: uma tabela de-para `bi.area_mapa (rotulo_normalizado,
canonico)`, semeada a partir dos rótulos reais mais frequentes, com o que não casar
caindo em `"outras"`. A view expõe **as duas colunas** — a canônica para o gráfico, a
crua para conferir. Uma página do relatório lista "rótulos ainda sem de-para, por
frequência": é a fila de manutenção, e ela se mantém curta sozinha.

Normalizar = minúsculas, sem acento (`unaccent`), sem "direito de/do/da", espaços
colapsados.

---

## 7. As duas tabelas novas no backend

Únicas mudanças de schema do plano — implementadas em [`backend/src/bi/`](../backend/src/bi/).
Ambas exigem `prisma db push` na VPS (aditivo, sem `--accept-data-loss`), com dump antes.

### 7.1 `BiPerfilDia` — o retrato diário

Conserta o aviso 3.b. Uma linha por perfil por dia, escrita por uma rotina que roda
junto do expurgo. É o que torna possível "quantos Pro em junho", coorte de retenção e
qualquer série que hoje não existe.

```prisma
// Retrato diário do perfil — a história que a linha de `Profile` não guarda.
// Escrito pela rotina diária; contém apenas cópia de campos que já existem no
// perfil, nada de novo sobre a pessoa. Cascade: excluir a conta apaga a história
// (LGPD art. 18, VI — exclusão que não alcança o derivado não é exclusão).
model BiPerfilDia {
  dia              DateTime // 00:00 local do dia retratado
  profileId        String
  profile          Profile  @relation(fields: [profileId], references: [id], onDelete: Cascade)
  planoContratado  String
  planoVigente     String   // calculado por planoVigente() — ver aviso abaixo
  situacaoCobranca String
  publicado        Boolean
  moderacao        String
  uf               String   @default("")
  emEscritorio     Boolean  @default(false)

  @@id([dia, profileId])
  @@index([dia])
}
```

> **O plano vigente é calculado em TypeScript, não em SQL.** `planoVigente()`
> (`src/assinatura.ts`) cruza plano contratado, status, `currentPeriodEnd`,
> `graceUntil` e `planScheduled`. Reescrever essa escada em SQL criaria uma segunda
> verdade, que divergiria no primeiro ajuste de carência. Por isso o snapshot é gravado
> **pelo backend**, que já sabe a resposta, e a view `bi` só lê a coluna.

Retenção: 800 dias — o dobro da janela de eventos, o que cobre a comparação ano contra
ano com folga. Custo: mil perfis por dois anos são ~730 mil linhas curtas. Irrelevante
para o Postgres, decisivo para as perguntas.

### 7.2 `BiEventoMes` — o agregado que sobrevive ao expurgo

Conserta o aviso 3.c. Antes de o expurgo apagar evento cru com mais de 400 dias, o mês
fechado já foi somado aqui.

```prisma
// Uso mensal agregado. Sobrevive ao expurgo de LinkEvent (400 dias) porque é
// contagem, não acontecimento. Grão: perfil × mês × tipo de evento.
model BiEventoMes {
  mes       DateTime // primeiro dia do mês, hora local
  profileId String
  profile   Profile  @relation(fields: [profileId], references: [id], onDelete: Cascade)
  evento    String
  total     Int

  @@id([mes, profileId, evento])
  @@index([mes])
}
```

A rotina soma **o mês anterior inteiro** e é idempotente (`upsert`): rodar dez vezes
tem o efeito de rodar uma — o mesmo princípio da varredura de assinaturas.

Sem prazo de retenção próprio: é contagem, sem sujeito identificável além do perfil, e
some por cascade quando a conta é excluída.

---

## 8. O modelo no Power BI

Estrela. Uma tabela de datas de verdade — não a data automática do Power BI, que cria
uma hierarquia oculta por coluna e incha o arquivo.

```
                  ┌──────────────┐
                  │ dCalendario  │  (DAX: CALENDAR, marcada como tabela de datas)
                  └──────┬───────┘
       ┌─────────────────┼──────────────────┬───────────────────┐
       │                 │                  │                   │
┌──────┴───────┐  ┌──────┴───────┐  ┌───────┴──────┐  ┌─────────┴────────┐
│fato_evento_  │  │ BiPerfilDia  │  │fato_denuncia │  │  fato_chamado    │
│     dia      │  │  (retrato)   │  │ fato_sancao  │  │ fato_contestacao │
└──────┬───────┘  └──────┬───────┘  └───────┬──────┘  └──────────────────┘
       └─────────────────┴──────────────────┘
                         │  perfil_id (1:N)
                  ┌──────┴───────┐        ┌────────────────┐
                  │  dim_perfil  ├────────┤ dim_escritorio │
                  └──────┬───────┘        └────────────────┘
                         │
                  ┌──────┴───────┐        ┌──────────────┐
                  │   dim_area   │        │   dPrecos    │ (manual, espelha planOffer.ts)
                  └──────────────┘        └──────────────┘
```

`dim_area` é 1:N com `dim_perfil` (um advogado tem várias áreas) — então ela filtra o
perfil, e não o contrário. Qualquer medida quebrada por área precisa de
`DISTINCTCOUNT` de perfil, nunca `SUM`, ou o mesmo advogado é contado quatro vezes.

### Medidas principais (DAX)

```dax
Perfis                = DISTINCTCOUNT ( dim_perfil[perfil_id] )
Publicados            = CALCULATE ( [Perfis], dim_perfil[publicado] = TRUE() )
Taxa de publicação    = DIVIDE ( [Publicados], [Perfis] )

Visitas               = CALCULATE ( SUM ( fato_evento_dia[total] ), fato_evento_dia[evento] = "view" )
Contatos              = CALCULATE ( SUM ( fato_evento_dia[total] ), fato_evento_dia[e_contato] = TRUE() )
Taxa de contato       = DIVIDE ( [Contatos], [Visitas] )

Ativos no dia         = CALCULATE ( DISTINCTCOUNT ( BiPerfilDia[profileId] ), BiPerfilDia[publicado] = TRUE() )
Pagos no dia          = CALCULATE ( DISTINCTCOUNT ( BiPerfilDia[profileId] ), BiPerfilDia[planoVigente] IN { "pro", "premium" } )

Receita contratada    = SUMX ( VALUES ( dPrecos[plano] ), [Pagos no dia] * dPrecos[valor] )   -- ver §3.a

Contestações no prazo = DIVIDE (
                          CALCULATE ( COUNTROWS ( fato_contestacao ), fato_contestacao[dentro_do_prazo] = TRUE() ),
                          COUNTROWS ( fato_contestacao ) )
```

O cuidado que sempre falta: `DIVIDE`, nunca `/`. Uma UF sem visita nenhuma vira divisão
por zero, e o visual inteiro morre com erro em vez de aparecer vazio.

---

## 9. As páginas do relatório

1. **Visão geral** — perfis, publicados, pagos, escritórios; série de cadastros por
   semana; mapa por UF; cadastros dos últimos 7 e 30 dias.
2. **Os clientes** — distribuição por UF e cidade; áreas canônicas; completude do perfil
   (foto, bio, áreas, FAQ, redes, vídeo); dias até publicar; quem nunca publicou.
3. **Coortes** — matriz mês de cadastro × meses desde o cadastro, célula = % ainda
   editando. É onde se enxerga se o produto segura alguém.
4. **Uso** — visitas e contatos no tempo; mapa de calor hora × dia da semana;
   distribuição por tipo de botão.
5. **O que faz um perfil funcionar** — taxa de contato comparada entre grupos: com e sem
   vídeo, com e sem FAQ, com e sem foto, assistente contra link externo, 1–2 contra 3+
   áreas. Cada barra com o `n` do grupo ao lado, e barra com `n` baixo em cinza — sem
   isso, sete perfis com vídeo viram "vídeo dobra o contato".
6. **Planos e receita contratada** — pagos por plano no tempo, subidas e descidas, com o
   rótulo de cobrança desligada enquanto for o caso.
7. **Confiança e operação** — denúncias por motivo e desfecho; sanções por degrau;
   contestações dentro do prazo (com alerta se cair de 100%); chamados por tipo e tempo
   de resposta; saúde do motor de conformidade (`ok`/`warn`/`block` por versão).
8. **Manutenção** — rótulos de área sem de-para; dias sem snapshot; último expurgo;
   contagem de linhas por view. A página que ninguém abre até o número ficar estranho.

Tema visual: fundo claro, uma cor de destaque, cinza para o resto. Nada de medidor,
nada de pizza com onze fatias.

---

## 10. Fases

| Fase | Entrega | Toca no backend? | Dias |
| --- | --- | --- | --- |
| **1** ✅ | Esquema `bi`, funções de fuso, views de §6.2–6.4, usuário `bi_leitor`, túnel documentado | `prisma/bi/bi.sql`, `bi_leitor.sql`, trava em `src/bi/bi-sql.spec.ts` | ~1,5 |
| **2** ✅ | `BiPerfilDia` e `BiEventoMes`, rotina diária idempotente, retenção de 800 dias, `npm run bi` | `src/bi/` + schema | ~1,5 |
| **3** ✅ | De-para de áreas e views de manutenção | `bi.sql` | ~0,5 |
| **4** | O relatório em si — páginas de §9 | não (é o `.pbix`) | ~2,5 |
| **5** | Painel admin (Fase 9 do plano-admin) passa a ler as mesmas views | sim | ~1 |
| **6** | *Opcional* — atualização automática (§11) | não | ~1 |

**Feito em 28/08/2026 (fases 1 a 3).** O que ficou pendente, e por quê:

- **Aplicar na VPS.** `prisma db push` (aditivo, duas tabelas novas), `npm run bi`
  e `psql -f prisma/bi/bi.sql` — roteiro em [DEPLOY-VPS.md](../DEPLOY-VPS.md) §12. O
  `bi.sql` nunca foi executado contra um Postgres: não há um na máquina de
  desenvolvimento, e rodar coisa nova direto em produção sem alguém olhando não é
  jeito de estrear camada nenhuma.
- **O `.pbix`.** Arquivo binário do Power BI, montado dentro do programa. As views,
  o modelo em estrela (§8) e as medidas DAX estão especificados; quem abrir o Power
  BI segue §8 e §9.

Ordem: **1 → 2** é fundação, e a 2 é urgente por um motivo que não espera. Todo dia sem
`BiPerfilDia` é um dia de história que não existirá nunca — o retrato de hoje não pode
ser reconstruído amanhã. As páginas do relatório podem esperar; o snapshot não.

---

## 11. Atualização — como o dado chega ao arquivo

**Hoje (Fases 1 a 4):** manual. Abre o túnel, aperta *Atualizar*, fecha o túnel. Para um
relatório que se olha uma ou duas vezes por semana, é honesto e custa zero.

**Se virar rotina (Fase 6):** o caminho barato **não é** gateway. Um
*On-premises Data Gateway* exigiria uma máquina ligada mantendo o túnel de pé, mais
licença Power BI Pro por pessoa. O caminho magro:

1. `cron` diário na VPS exporta cada view `bi.*` com `\copy ... to csv`;
2. `rclone` ou `scp` joga a pasta num OneDrive;
3. o Power BI Service atualiza a partir do OneDrive **sem gateway nenhum**.

A escolha entre os dois é de custo e de quantas pessoas olham — não de arquitetura. As
views não mudam em nenhum dos casos.

---

## 12. Riscos e pendências

| Risco | Como fica |
| --- | --- |
| Fuso trocado em silêncio | `bi.dia_local`/`bi.hora_local` são a única forma de datar; nenhuma view usa `date()` cru. Um teste compara a contagem por dia da view com a do `AnalyticsService` num perfil semeado. |
| `EVENTOS_DE_CONTATO` duplicado no SQL | Trava de paridade: um teste lê `bi.sql`, extrai a lista e compara com `eventos.ts`. Mesmo padrão de `oab.rules.ts`. |
| Regra de plano vigente duplicada | Não é duplicada — o snapshot é escrito pelo backend (§7.1). O SQL nunca decide plano. |
| Senha do `bi_leitor` vazar | Só lê views agregadas, num banco que só aceita conexão local: sem túnel, a senha sozinha não abre nada. Rotação anual. |
| `.pbix` com dado de cliente na máquina | Sem e-mail, OAB, WhatsApp ou texto de denúncia dentro (§4). O pior caso é a lista de slugs — que é pública. |
| Exclusão de conta não alcançar o BI | `onDelete: Cascade` nas duas tabelas novas, e as views leem `Profile` — some na hora. Entra no roteiro de teste de `/conta/dados`. |
| Confundir correlação com causa na página 5 | `n` visível em todo grupo, grupo pequeno em cinza, e a página abre dizendo que são grupos comparados, não experimento. |
| Power BI Desktop só existe em Windows | A máquina do dono é Windows 11. Se um dia mudar, as views continuam servindo Metabase, Looker Studio ou qualquer outro — nada aqui é específico do Power BI, exceto o `.pbix`. |

---

## 13. O corte mínimo

Se for para fazer só uma coisa desta lista: **a Fase 2**. Sem relatório nenhum, sem
Power BI instalado, sem view alguma — só a rotina que grava o retrato diário. É a única
parte do plano cujo adiamento destrói informação, em vez de apenas atrasá-la.
