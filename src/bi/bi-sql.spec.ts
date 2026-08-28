import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVENTOS, EVENTOS_DE_CONTATO } from '../analytics/eventos'

// A TRAVA DA CAMADA `bi`.
//
// prisma/bi/bi.sql não é código TypeScript: o compilador não o lê, os testes não
// o executam e ninguém percebe quando ele fica para trás. É exatamente o perfil
// de arquivo que apodrece em silêncio — e o sintoma seria um relatório com
// número errado, não um erro.
//
// Este arquivo confere três coisas que só se descobrem lendo o SQL:
//
//   1. a lista de eventos de contato ainda é a mesma de eventos.ts;
//   2. nenhum dado pessoal desnecessário entrou nas views;
//   3. nenhuma data virou dia sem passar pela conversão de fuso.
//
// Mesmo espírito da trava de paridade de oab.rules.ts.

const SQL = readFileSync(join(__dirname, '..', '..', 'prisma', 'bi', 'bi.sql'), 'utf8')

/** O SQL sem comentários e sem literais de texto — só o que o banco executa. */
const CODIGO = SQL.replace(/--[^\n]*/g, ' ').replace(/'[^']*'/g, "''")

describe('a lista de eventos de contato espelha eventos.ts', () => {
  // O espelho existe porque a agregação acontece no banco, longe do TypeScript.
  // A trava existe porque espelho sem trava vira mentira na primeira mudança.
  const listas = [...SQL.matchAll(/kind in \(([^)]*)\)|evento in \(([^)]*)\)/g)].map((m) =>
    (m[1] ?? m[2])
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  )

  it('o SQL declara a lista em algum lugar', () => {
    expect(listas.length).toBeGreaterThan(0)
  })

  it('toda ocorrência no SQL é exatamente EVENTOS_DE_CONTATO', () => {
    for (const lista of listas) {
      expect([...lista].sort()).toEqual([...EVENTOS_DE_CONTATO].sort())
    }
  })

  it('as ocorrências são idênticas entre si', () => {
    for (const lista of listas) expect(lista).toEqual(listas[0])
  })

  it('todo evento citado no SQL é um evento válido', () => {
    for (const lista of listas) for (const e of lista) expect(EVENTOS).toContain(e)
  })
})

describe('nada de dado pessoal desnecessário nas views', () => {
  // A lista abaixo não é de campos "sensíveis" no sentido vago: é do que um
  // .pbix na máquina de alguém não tem por que carregar. Arquivo de relatório
  // não tem sessão que expira, não tem trilha de acesso e não tem quem auditar.
  const proibidos = [
    'password',
    'oabNumber',
    'whatsapp',
    'reporterEmail',
    'bioSnapshot',
    'payload',
    'ipFingerprint',
    'userAgent',
    'totpSecret',
    'tokenHash',
    'adminLabel',
    'suspendedReason',
    'closedReason',
    'moderationNote',
    'adminNote',
  ]

  for (const campo of proibidos) {
    it(`não expõe ${campo}`, () => {
      expect(CODIGO.toLowerCase()).not.toContain(campo.toLowerCase())
    })
  }

  it('não expõe e-mail, nome nem texto livre de caso', () => {
    for (const re of [/\bemail\b/i, /\bname\b/i, /\bdetails\b/i, /\btexto\b/i, /\bmessage\b/i]) {
      expect(CODIGO).not.toMatch(re)
    }
  })
})

describe('nenhuma data vira dia sem passar pelo fuso', () => {
  // O defeito silencioso: `date("createdAt")` datando por UTC. Entre 21h e
  // meia-noite de Brasília já é o dia seguinte em UTC, então três horas de
  // movimento por dia caem no dia errado — sem erro, sem sintoma, para sempre.
  it('não usa date() em coluna de instante', () => {
    expect(CODIGO).not.toMatch(/\bdate\s*\(\s*"/)
  })

  it('não usa ::date em coluna de instante', () => {
    // `d.dia::date` e `m.mes::date` são permitidos e existem: `dia` e `mes` já
    // são rótulos de calendário gravados pelo serviço (ver src/bi/tempo.ts).
    // Coluna citada entre aspas é camelCase do Prisma, isto é, um instante.
    expect(CODIGO).not.toMatch(/"\w+"\s*::\s*date/)
  })

  it('extrai a hora num lugar só — dentro de bi.hora_local', () => {
    expect(CODIGO.match(/extract\s*\(\s*hour/gi) ?? []).toHaveLength(1)
  })

  it('a conversão de fuso tem os dois passos', () => {
    // Só `at time zone 'America/Sao_Paulo'` num timestamp SEM fuso faria o
    // Postgres interpretá-lo como se já fosse hora de Brasília — o erro anda
    // para o lado contrário e continua invisível.
    const conversoes = SQL.match(/at time zone 'UTC'\) at time zone 'America\/Sao_Paulo'/g) ?? []
    expect(conversoes.length).toBeGreaterThanOrEqual(2)
    expect(SQL.match(/at time zone 'America\/Sao_Paulo'/g) ?? []).toHaveLength(conversoes.length)
  })
})

describe('o arquivo continua aplicável mais de uma vez', () => {
  it('toda view é create or replace', () => {
    const views = SQL.match(/create\s+(or replace\s+)?view/gi) ?? []
    expect(views.length).toBeGreaterThan(5)
    for (const v of views) expect(v.toLowerCase()).toContain('or replace')
  })

  it('a tabela de de-para não é recriada por cima do que já existe', () => {
    expect(SQL).toMatch(/create table if not exists bi\.area_mapa/i)
    expect(SQL).toMatch(/on conflict \(rotulo_normalizado\) do nothing/i)
  })

  it('as permissões do leitor são reaplicadas — view recriada volta invisível', () => {
    expect(SQL).toMatch(/grant select on all tables in schema bi to bi_leitor/i)
  })

  it('não usa security_invoker — é o que faria o leitor perder o acesso', () => {
    expect(CODIGO.toLowerCase()).not.toContain('security_invoker')
  })
})
