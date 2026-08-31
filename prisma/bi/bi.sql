-- ===========================================================================
-- CAMADA `bi` — o que o Power BI (ou qualquer outra ferramenta) enxerga.
--
-- Plano: docs/plano-bi.md
--
-- APLICAR (na VPS, com o usuário dono do banco):
--     psql "$DATABASE_URL" -f prisma/bi/bi.sql
--
-- É idempotente: `create or replace` em tudo, `if not exists` nas tabelas.
-- Rodar de novo depois de cada `prisma db push` que mexa nas colunas usadas
-- aqui — view no Postgres guarda a lista de colunas resolvida na criação, então
-- coluna nova não aparece sozinha.
--
-- ---------------------------------------------------------------------------
-- POR QUE VIEWS E NÃO ACESSO DIRETO ÀS TABELAS
--
-- No Postgres, uma view roda com os privilégios do DONO dela. Estas views
-- pertencem ao dono do banco; o usuário `bi_leitor` (ver bi_leitor.sql) tem
-- permissão apenas no esquema `bi`. Ele lê o resultado sem ter direito nenhum
-- sobre "User", "Session" ou "BillingEvent" — apontar um psql para lá devolve
-- `permission denied`.
--
-- A minimização deixa de depender de disciplina e passa a estar no banco. É o
-- ponto inteiro deste arquivo, e é o que `security_invoker = true` destruiria.
--
-- ---------------------------------------------------------------------------
-- O QUE NÃO ENTRA AQUI, NUNCA
--
--   e-mail · hash de senha · número de OAB · WhatsApp · telefone
--   texto de denúncia (`details`) · e-mail do denunciante
--   texto de contestação · retrato de bio (`bioSnapshot`)
--   payload de cobrança · ipFingerprint · userAgent · IP de ação de admin
--
-- Não é excesso de zelo: um `.pbix` na máquina de alguém não tem trilha de
-- acesso, não tem sessão que expira e não tem quem auditar. O que identifica um
-- advogado individual é assunto do painel, onde toda consulta vira AdminAction.
--
-- E não existe dado de VISITANTE em lugar nenhum do banco (decisão de
-- 21/08/2026, ver src/analytics/eventos.ts): contamos acontecimentos, nunca
-- pessoas. Não há visitante único para agregar aqui porque não há visitante
-- único gravado lá.
-- ===========================================================================

create schema if not exists bi;

-- ---------------------------------------------------------------------------
-- 1. FUSO HORÁRIO — a armadilha silenciosa
--
-- O Prisma mapeia DateTime para `timestamp(3)` SEM FUSO, e a VPS roda em UTC.
-- Um `date("createdAt")` cru joga tudo que acontece entre 21h e meia-noite de
-- Brasília para o dia seguinte, e desloca o gráfico "por hora" em três casas: o
-- pico das 20h aparece às 23h. O erro é discreto, constante e não dá erro
-- nenhum — só faz toda conclusão sobre horário ficar errada.
--
-- A conversão tem DOIS passos, e pular o primeiro é o engano comum: primeiro se
-- declara que o valor guardado é UTC (`at time zone 'UTC'` num timestamp sem
-- fuso devolve timestamptz), depois se traz para São Paulo.
--
-- STABLE e não IMMUTABLE: a tabela de fusos do sistema muda (horário de verão
-- vai e volta por decreto). IMMUTABLE mentiria para o planejador e deixaria um
-- índice funcional guardar o resultado de uma regra que já mudou.
-- ---------------------------------------------------------------------------

create or replace function bi.dia_local(ts timestamp) returns date
  language sql stable as
$$ select ((ts at time zone 'UTC') at time zone 'America/Sao_Paulo')::date $$;

create or replace function bi.hora_local(ts timestamp) returns int
  language sql stable as
$$ select extract(hour from ((ts at time zone 'UTC') at time zone 'America/Sao_Paulo'))::int $$;

-- Horas entre dois instantes, com uma casa. `null` enquanto não terminou.
create or replace function bi.horas_entre(inicio timestamp, fim timestamp) returns numeric
  language sql immutable as
$$ select case when fim is null or inicio is null then null
               else round((extract(epoch from (fim - inicio)) / 3600.0)::numeric, 1) end $$;

-- ---------------------------------------------------------------------------
-- 2. dim_perfil — quem são os clientes
--
-- Sem nome, sem e-mail, sem OAB, sem WhatsApp. O `slug` fica porque é público
-- (é o endereço da página) e é o que permite ir do relatório para o perfil real
-- quando algum número chamar atenção.
-- ---------------------------------------------------------------------------

create or replace view bi.dim_perfil as
select
  p.id                                    as perfil_id,
  p.slug,
  nullif(p.state, '')                     as uf,
  nullif(p.city, '')                      as cidade,
  p.plan::text                            as plano_contratado,
  p."planStatus"::text                    as situacao_cobranca,
  p.published                             as publicado,
  p."moderationStatus"::text              as moderacao,
  p."schedulingMode"                      as modo_agendamento,
  p.theme                                 as tema,
  (p."avatarUrl" is not null)             as tem_foto,
  (p."videoUrl" is not null)              as tem_video,
  (p.card <> '')                          as tem_cartao,
  (p.bio <> '')                           as tem_bio,
  (p.headline <> '')                      as tem_chamada,
  length(p.bio)                           as bio_caracteres,
  (select count(*) from "PracticeArea" a where a."profileId" = p.id) as areas,
  (select count(*) from "Faq" f          where f."profileId" = p.id) as perguntas,
  (select count(*) from "SocialLink" s   where s."profileId" = p.id) as redes,
  (fm.id is not null)                     as em_escritorio,
  fm."firmId"                             as escritorio_id,
  bi.dia_local(p."createdAt")             as cadastro_em,
  bi.dia_local(p."updatedAt")             as ultima_edicao_em,
  bi.dia_local(u."createdAt")             as conta_criada_em,
  (u."suspendedAt" is not null)           as conta_suspensa,
  (u."closedAt" is not null)              as conta_encerrada
from "Profile" p
join "User" u on u.id = p."userId"
left join "FirmMembership" fm on fm."profileId" = p.id;

comment on view bi.dim_perfil is
  'Um perfil por linha. Sem nome, e-mail, OAB ou WhatsApp — ver o cabeçalho de bi.sql.';

-- ---------------------------------------------------------------------------
-- 3. fato_evento_dia — uso, já agregado na origem
--
-- O Power BI nunca vê a linha crua de LinkEvent. Sai daqui somado por perfil,
-- dia, hora e tipo: reduz o volume em uma ou duas ordens de grandeza e torna
-- impossível reconstruir sequência de acessos a partir do arquivo do relatório.
--
-- ⚠️ A lista de eventos de contato ESPELHA EVENTOS_DE_CONTATO em
-- src/analytics/eventos.ts. Espelho é dívida, e esta tem trava: o teste
-- src/bi/bi-sql.spec.ts lê este arquivo, extrai a lista e compara. Mudar lá sem
-- mudar aqui quebra a suíte — que é o único jeito de um espelho não apodrecer.
-- ---------------------------------------------------------------------------

create or replace view bi.fato_evento_dia as
select
  e."profileId"                as perfil_id,
  bi.dia_local(e."createdAt")  as dia,
  bi.hora_local(e."createdAt") as hora,
  e.kind                       as evento,
  (e.kind in ('whatsapp', 'agendamento', 'assistente', 'email', 'cartao', 'endereco')) as e_contato,
  count(*)                     as total
from "LinkEvent" e
group by 1, 2, 3, 4, 5;

comment on view bi.fato_evento_dia is
  'Visitas e cliques somados por perfil/dia/hora/tipo. Evento cru vive 400 dias.';

-- ---------------------------------------------------------------------------
-- 4. O histórico que as tabelas de estado não guardam (ver src/bi)
--
-- `dia` e `mes` são RÓTULOS de calendário guardados como meia-noite UTC, não
-- instantes — por isso o `::date` seco aqui, sem conversão de fuso. Converter
-- de novo o que já foi convertido na gravação é como o erro entra.
-- ---------------------------------------------------------------------------

create or replace view bi.fato_perfil_dia as
select
  d."profileId"        as perfil_id,
  d.dia::date          as dia,
  d."planoContratado"  as plano_contratado,
  d."planoVigente"     as plano_vigente,
  d."situacaoCobranca" as situacao_cobranca,
  d.publicado,
  d.moderacao,
  nullif(d.uf, '')     as uf,
  d."emEscritorio"     as em_escritorio,
  (d."planoVigente" in ('pro', 'premium')) as pago
from "BiPerfilDia" d;

comment on view bi.fato_perfil_dia is
  'Retrato diário do perfil. plano_vigente vem de planoVigente() — o SQL nunca decide plano.';

create or replace view bi.fato_evento_mes as
select
  m."profileId" as perfil_id,
  m.mes::date   as mes,
  m.evento,
  m.total,
  (m.evento in ('whatsapp', 'agendamento', 'assistente', 'email', 'cartao', 'endereco')) as e_contato
from "BiEventoMes" m;

comment on view bi.fato_evento_mes is
  'Uso mensal agregado. Sobrevive ao expurgo de LinkEvent — é o histórico longo.';

-- ---------------------------------------------------------------------------
-- 5. Escritórios
-- ---------------------------------------------------------------------------

create or replace view bi.dim_escritorio as
select
  f.id                        as escritorio_id,
  f.slug,
  nullif(f.state, '')         as uf,
  nullif(f.city, '')          as cidade,
  f.plan::text                as plano,
  f."seatsPurchased"          as assentos_comprados,
  count(m.id) filter (where m.status = 'active')  as assentos_em_uso,
  count(m.id) filter (where m.status = 'invited') as convites_pendentes,
  greatest(f."seatsPurchased" - count(m.id) filter (where m.status = 'active'), 0) as assentos_ociosos,
  bi.dia_local(f."createdAt") as criado_em
from "Firm" f
left join "FirmMembership" m on m."firmId" = f.id
group by f.id;

-- ---------------------------------------------------------------------------
-- 6. Moderação, contestação e suporte
--
-- Só o esqueleto do caso: motivo, desfecho e RELÓGIO. O texto de quem denunciou
-- e o de quem se defendeu ficam onde já estavam.
-- ---------------------------------------------------------------------------

create or replace view bi.fato_denuncia as
select
  r.id                                     as denuncia_id,
  r."profileId"                            as perfil_id,
  r.reason                                 as motivo,
  r.status::text                           as situacao,
  coalesce(r.resolution, '')               as desfecho,
  bi.dia_local(r."createdAt")              as aberta_em,
  bi.dia_local(r."handledAt")              as encerrada_em,
  bi.horas_entre(r."createdAt", r."handledAt") as horas_ate_encerrar
from "Report" r;

-- Sanções e medidas de conta, a partir da trilha do painel. Sem lista fixa de
-- ações: a escada de docs/politica-de-sancoes.md ganha degrau, e um `in (...)`
-- aqui esconderia o degrau novo do relatório sem avisar ninguém.
create or replace view bi.fato_sancao as
select
  a.id                        as acao_id,
  a.action                    as acao,
  split_part(a.action, '.', 1) as familia,
  split_part(a.action, '.', 2) as degrau,
  a."targetType"              as tipo_de_alvo,
  a."adminRole"               as papel_do_admin,
  bi.dia_local(a."createdAt") as dia
from "AdminAction" a
where a.action like 'moderacao.%' or a.action like 'conta.%';

-- Contestações. `dentro_do_prazo` é o número que importa: silêncio por 10 dias
-- derruba a medida (docs/politica-de-sancoes.md), então cair de 100% aqui é
-- risco jurídico, não indicador de produtividade.
create or replace view bi.fato_contestacao as
select
  c.id                                   as contestacao_id,
  c.alvo,
  c.medida,
  c.status                               as situacao,
  bi.dia_local(c."createdAt")            as aberta_em,
  bi.dia_local(c."respondeAte")          as responder_ate,
  bi.dia_local(c."decidedAt")            as decidida_em,
  (c."decidedAt" is not null and c."decidedAt" <= c."respondeAte") as dentro_do_prazo,
  (c."decidedAt" is null and now() > c."respondeAte")              as vencida_sem_resposta,
  bi.horas_entre(c."createdAt", c."decidedAt") as horas_ate_decidir
from "Appeal" c;

create or replace view bi.fato_chamado as
select
  t.id                        as chamado_id,
  t.kind::text                as tipo,
  t.status::text              as situacao,
  bi.dia_local(t."createdAt") as aberto_em,
  bi.dia_local(t."handledAt") as encerrado_em,
  bi.horas_entre(t."createdAt", t."handledAt") as horas_ate_encerrar
from "SupportTicket" t;

-- Saúde do motor de conformidade: quanto ele bloqueia, quanto avisa, e sob qual
-- revisão de regra. Sem o retrato da bio.
create or replace view bi.fato_conformidade as
select
  l."profileId"               as perfil_id,
  l.action                    as acao,
  l."complianceStatus"        as resultado,
  l."policyVersion"           as versao_da_politica,
  bi.dia_local(l."createdAt") as dia,
  count(*)                    as total
from "AuditLog" l
group by 1, 2, 3, 4, 5;

-- ---------------------------------------------------------------------------
-- 7. Áreas de atuação — o de-para
--
-- `PracticeArea.label` é texto livre. "Direito de Família", "Familia",
-- "familiar" e "Família e Sucessões" são quatro linhas diferentes e um gráfico
-- inútil: sem normalizar, a pergunta "que áreas dominam a base?" não tem
-- resposta, ela tem uma nuvem.
--
-- Dois passos, de propósito:
--   1. NORMALIZAR — mecânico e sem opinião (minúscula, sem acento, sem as
--      palavras de ligação). Junta "Direito de Família" e "familia".
--   2. DE-PARA — humano e com opinião. É o que junta "familia" e "sucessoes"
--      sob "Família e Sucessões", e nenhuma regra automática acerta isso.
--
-- Sem a extensão `unaccent`: instalar extensão exige superusuário, e o dono do
-- banco de aplicação não é (nem deve ser). `translate` resolve o alfabeto que
-- de fato aparece em português.
-- ---------------------------------------------------------------------------

create or replace function bi.area_normalizar(rotulo text) returns text
  language sql immutable as
$$
  select trim(regexp_replace(
    regexp_replace(
      translate(
        lower(coalesce(rotulo, '')),
        'áàâãäéèêëíìîïóòôõöúùûüçñ',
        'aaaaaeeeeiiiiooooouuuucn'
      ),
      '\y(direito|direitos|area|areas|de|do|da|dos|das|e|em|para)\y', ' ', 'g'
    ),
    '[^a-z0-9]+', ' ', 'g'
  ))
$$;

create table if not exists bi.area_mapa (
  rotulo_normalizado text primary key,
  canonico           text not null
);

comment on table bi.area_mapa is
  'De-para das áreas de atuação. Alimentado pela fila de bi.manutencao_areas.';

-- Semente: os rótulos que a base já usa. Não é lista fechada — o que não casar
-- cai em "Outras" e aparece na fila de manutenção, por frequência.
insert into bi.area_mapa (rotulo_normalizado, canonico) values
  ('familia',                  'Família e Sucessões'),
  ('familiar',                 'Família e Sucessões'),
  ('familia sucessoes',        'Família e Sucessões'),
  ('sucessoes',                'Família e Sucessões'),
  ('inventario',               'Família e Sucessões'),
  ('divorcio',                 'Família e Sucessões'),
  ('trabalhista',              'Trabalhista'),
  ('trabalho',                 'Trabalhista'),
  ('previdenciario',           'Previdenciário'),
  ('previdencia',              'Previdenciário'),
  ('inss',                     'Previdenciário'),
  ('civil',                    'Civil'),
  ('responsabilidade civil',   'Civil'),
  ('contratos',                'Civil'),
  ('consumidor',               'Consumidor'),
  ('criminal',                 'Criminal'),
  ('penal',                    'Criminal'),
  ('tributario',               'Tributário'),
  ('fiscal',                   'Tributário'),
  ('empresarial',              'Empresarial'),
  ('societario',               'Empresarial'),
  ('imobiliario',              'Imobiliário'),
  ('administrativo',           'Administrativo'),
  ('ambiental',                'Ambiental'),
  ('digital',                  'Digital e Proteção de Dados'),
  ('protecao dados',           'Digital e Proteção de Dados'),
  ('lgpd',                     'Digital e Proteção de Dados'),
  ('medico',                   'Médico e da Saúde'),
  ('saude',                    'Médico e da Saúde'),
  ('bancario',                 'Bancário'),
  ('propriedade intelectual',  'Propriedade Intelectual'),
  ('internacional',            'Internacional'),
  ('eleitoral',                'Eleitoral'),
  ('militar',                  'Militar'),
  ('agrario',                  'Agrário'),
  ('condominial',              'Imobiliário'),
  ('execucao fiscal',          'Tributário')
on conflict (rotulo_normalizado) do nothing;

create or replace view bi.dim_area as
select
  a."profileId"                    as perfil_id,
  a.label                          as rotulo,
  bi.area_normalizar(a.label)      as rotulo_normalizado,
  coalesce(m.canonico, 'Outras')   as area,
  (m.rotulo_normalizado is null)   as sem_de_para
from "PracticeArea" a
left join bi.area_mapa m on m.rotulo_normalizado = bi.area_normalizar(a.label);

comment on view bi.dim_area is
  'ATENÇÃO: 1:N com dim_perfil. Contar perfil por área exige DISTINCTCOUNT, nunca SUM.';

-- ---------------------------------------------------------------------------
-- 8. Manutenção — a página que ninguém abre até o número ficar estranho
-- ---------------------------------------------------------------------------

-- Fila do de-para: o que ainda cai em "Outras", do mais frequente ao menos.
create or replace view bi.manutencao_areas as
select
  bi.area_normalizar(a.label) as rotulo_normalizado,
  min(a.label)                as exemplo,
  count(*)                    as perfis
from "PracticeArea" a
left join bi.area_mapa m on m.rotulo_normalizado = bi.area_normalizar(a.label)
where m.rotulo_normalizado is null
group by 1
order by 3 desc;

-- Buracos no retrato diário. Dia sem linha é dia que a rotina não rodou — e o
-- retrato de um dia perdido NÃO pode ser reconstruído depois. A view mostra o
-- buraco em vez de o relatório desenhar uma linha reta por cima dele: série
-- temporal que interpola ausência é a forma mais convincente de mentir num
-- gráfico.
create or replace view bi.manutencao_snapshot as
select
  d::date                as dia,
  coalesce(s.perfis, 0)  as perfis,
  (s.perfis is null)     as faltando
from generate_series(current_date - 89, current_date, interval '1 day') d
left join (
  select dia::date as dia, count(*) as perfis from "BiPerfilDia" group by 1
) s on s.dia = d::date;

-- Volume de cada objeto exposto — para conferir de longe se alguma view secou.
create or replace view bi.manutencao_volume as
select 'dim_perfil'       as objeto, count(*) as linhas from bi.dim_perfil
union all select 'fato_evento_dia',   count(*) from bi.fato_evento_dia
union all select 'fato_evento_mes',   count(*) from bi.fato_evento_mes
union all select 'fato_perfil_dia',   count(*) from bi.fato_perfil_dia
union all select 'dim_escritorio',    count(*) from bi.dim_escritorio
union all select 'dim_area',          count(*) from bi.dim_area
union all select 'fato_denuncia',     count(*) from bi.fato_denuncia
union all select 'fato_sancao',       count(*) from bi.fato_sancao
union all select 'fato_contestacao',  count(*) from bi.fato_contestacao
union all select 'fato_chamado',      count(*) from bi.fato_chamado
union all select 'fato_conformidade', count(*) from bi.fato_conformidade;

-- ---------------------------------------------------------------------------
-- 9. Permissões — reaplicadas a cada execução
--
-- `create or replace view` recria o objeto; sem isto, uma view atualizada
-- voltaria a ser invisível para o leitor e o relatório quebraria em silêncio no
-- dia seguinte ao deploy. O `if exists` deixa o arquivo rodar antes de o
-- usuário existir (ver bi_leitor.sql).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'bi_leitor') then
    execute 'grant usage on schema bi to bi_leitor';
    execute 'grant select on all tables in schema bi to bi_leitor';
    execute 'revoke all on bi.area_mapa from bi_leitor';
    execute 'grant select on bi.area_mapa to bi_leitor';
  end if;
end
$$;
