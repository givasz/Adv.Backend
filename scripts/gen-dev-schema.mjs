// Gera prisma/schema.dev.prisma a partir de prisma/schema.prisma.
//
// O schema de desenvolvimento é o MESMO de produção com duas diferenças que o
// SQLite exige: o provider e a ausência de enums. Mantê-lo à mão fazia ele ficar
// para trás em silêncio — chegou a estar três modelos atrasado, e o efeito era
// o cadastro quebrar só no ambiente local, que é justamente onde se testa.
//
// Uso:  npm run prisma:dev-schema
//
// Nunca editar prisma/schema.dev.prisma à mão: a próxima execução desfaz.

import { readFileSync, writeFileSync } from 'node:fs'

const ORIGEM = 'prisma/schema.prisma'
const DESTINO = 'prisma/schema.dev.prisma'

// Quebra de linha normalizada ANTES de qualquer expressão regular.
//
// Sem isto o gerador se destruía em silêncio no Windows. Em arquivo com quebra
// de linha CRLF, toda linha termina em retorno de carro — e o ponto, no
// JavaScript, NÃO casa retorno de carro (é terminador de linha, como o avanço de
// linha). A expressão que converte os campos termina em `(.*)$`, então ela nunca
// casava: nenhum campo tipado por enum virava String, enquanto as declarações
// dos enums eram removidas do mesmo jeito (passo 2). O schema saía referenciando
// tipos que não existem mais, o Prisma lê tipo desconhecido como RELAÇÃO, e o
// resultado eram 14 erros de validação.
//
// O pior não era o erro, era o silêncio: o script imprimia "9 enums viraram
// String" e saía com código 0. Quem clonasse o projeto no Windows não conseguia
// subir o banco local, e a mensagem de erro apontava para os índices do schema —
// nunca para este arquivo.
const prod = readFileSync(ORIGEM, 'utf8').replace(/\r\n/g, '\n')

// 1. Quais são os enums e quais valores cada um aceita (o valor vira texto no default).
const enums = new Map()
for (const m of prod.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
  const valores = m[2]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
  enums.set(m[1], new Set(valores))
}

let out = prod

// 2. Fora os blocos enum.
out = out.replace(/^enum\s+\w+\s*\{[^}]*\}\n?/gm, '')

// 3. Campo tipado por enum vira String; o default vira texto.
out = out
  .split('\n')
  .map((linha) => {
    const m = /^(\s+)(\w+)(\s+)(\w+)(\??)(\s*)(.*)$/.exec(linha)
    if (!m || !enums.has(m[4])) return linha
    const [, ind, campo, esp1, tipo, opcional, esp2, resto] = m
    const nomes = enums.get(tipo)
    const ajustado = resto.replace(/@default\((\w+)\)/, (todo, v) =>
      nomes.has(v) ? `@default("${v}")` : todo,
    )
    return `${ind}${campo}${esp1}String${opcional}${esp2}${ajustado}`
  })
  .join('\n')

// 4. Provider do banco.
out = out.replace(
  /datasource db \{[^}]*\}/,
  'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}',
)

// 5. Cabeçalho — quem abrir o arquivo precisa saber que ele é gerado.
const cabecalho = `// ⚠️ ARQUIVO GERADO — não edite à mão.
// Fonte: prisma/schema.prisma · Gerador: scripts/gen-dev-schema.mjs
// Regenerar:  npm run prisma:dev-schema
//
// Schema de DESENVOLVIMENTO LOCAL (SQLite). É o schema de produção com duas
// diferenças que o SQLite exige: o provider e a ausência de enums (os campos
// tipados por enum viram String, com o default em texto).
//
// Uso:  npx prisma db push --schema prisma/schema.dev.prisma
//       npx prisma studio  --schema prisma/schema.dev.prisma
`
out = cabecalho + out.replace(/^\/\/[^\n]*\n(\/\/[^\n]*\n)*/, '')

// 6. Conferência: nenhum nome de enum pode ter sobrado no arquivo.
//
// Esta trava é a lição do bug de CRLF. O problema não foi a expressão regular
// errada — foi ela falhar CALADA, gerando um arquivo inválido com mensagem de
// sucesso. Aqui o script prova que fez o que disse: se um `FirmMemberStatus`
// escapou, ele para com código 1 e diz o nome do campo, em vez de deixar o
// Prisma reclamar de um índice três telas depois.
const sobraram = []
for (const nome of enums.keys()) {
  const usoComoTipo = new RegExp(`^\\s+\\w+\\s+${nome}\\b`, 'm')
  if (usoComoTipo.test(out)) sobraram.push(nome)
}
if (sobraram.length > 0) {
  console.error(
    `ERRO: o schema gerado ainda referencia ${sobraram.length} enum(s) cuja declaração foi removida:\n` +
      sobraram.map((n) => `  • ${n}`).join('\n') +
      `\n\nO Prisma leria cada um como uma RELAÇÃO para um modelo inexistente.` +
      `\n${DESTINO} NÃO foi gravado.`,
  )
  process.exit(1)
}

writeFileSync(DESTINO, out.replace(/\n{3,}/g, '\n\n'), 'utf8')
console.log(`${DESTINO} gerado a partir de ${ORIGEM} (${enums.size} enums viraram String).`)
