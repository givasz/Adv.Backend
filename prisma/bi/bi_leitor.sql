-- ===========================================================================
-- O USUÁRIO DE LEITURA DO BI — roda UMA vez, à mão, na VPS.
--
--     export BI_SENHA="$(openssl rand -base64 24)"
--     psql "$DATABASE_URL" -v senha="'$BI_SENHA'" -f prisma/bi/bi_leitor.sql
--     echo "$BI_SENHA"     # guardar no gerenciador de senhas e limpar o histórico
--
-- Depois, sempre, `psql "$DATABASE_URL" -f prisma/bi/bi.sql` — é ele que dá as
-- permissões nas views (e as redá toda vez que uma view é recriada).
--
-- ---------------------------------------------------------------------------
-- O QUE ESTE USUÁRIO PODE
--
-- Ler as views do esquema `bi`. Nada mais. Não é uma restrição de bom senso: as
-- views pertencem ao dono do banco e, no Postgres, view roda com o privilégio
-- do dono — então o resultado sai mesmo sem o leitor ter direito algum sobre as
-- tabelas por trás. Apontar um psql deste usuário para "User" ou "Session"
-- devolve `permission denied`.
--
-- Ele também não escreve, não cria e não vê o esquema `public`.
--
-- ---------------------------------------------------------------------------
-- COMO O POWER BI CHEGA AQUI
--
-- O Postgres escuta em 127.0.0.1 e o ufw só deixa entrar 22, 80 e 443 (ver
-- DEPLOY-VPS.md). Não abra a 5432: o túnel SSH entrega o mesmo por uma porta
-- que já está aberta, com chave e fail2ban na frente.
--
--     ssh -N -L 15432:127.0.0.1:5432 root@<ip-da-vps>
--
-- No Power BI: Obter dados → Banco de dados PostgreSQL
--     Servidor: localhost:15432    Banco: advocme
--     Usuário: bi_leitor           Modo: Importação (não DirectQuery)
--
-- Importação, e não DirectQuery, porque o volume é pequeno e porque DirectQuery
-- deixaria o relatório inteiro mudo toda vez que o túnel caísse.
-- ===========================================================================

-- Senha vem por -v senha='...' para não ficar escrita neste arquivo versionado.
create role bi_leitor login password :senha;

-- Nada no esquema da aplicação. (No Postgres 15+ o public já nasce fechado; a
-- linha continua aqui porque a VPS pode estar em versão anterior.)
revoke all on schema public from bi_leitor;
revoke all privileges on all tables in schema public from bi_leitor;

grant connect on database advocme to bi_leitor;
grant usage on schema bi to bi_leitor;
grant select on all tables in schema bi to bi_leitor;

-- View criada amanhã já nasce legível — sem isto, cada objeto novo exigiria
-- lembrar de vir aqui, e o esquecimento aparece como tabela faltando no
-- relatório, semanas depois.
alter default privileges in schema bi grant select on tables to bi_leitor;

-- Só leitura, em qualquer circunstância.
alter role bi_leitor set default_transaction_read_only = on;

-- Conferência (deve devolver `f` para as três):
--   select has_table_privilege('bi_leitor', '"User"',    'select');
--   select has_table_privilege('bi_leitor', '"Session"', 'select');
--   select has_schema_privilege('bi_leitor', 'public',   'usage');
