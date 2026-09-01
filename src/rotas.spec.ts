// TODA rota da API tem uma porta — e a lista de quem não tem é escrita à mão.
//
// ---------------------------------------------------------------------------
// POR QUE ESTE ARQUIVO EXISTE
//
// `admin/admin-rotas.spec.ts` já cobra que toda rota do PAINEL peça uma
// permissão nomeada. Fora do painel não havia nada: uma rota nova de advogado
// que esquecesse `requireUser` entrava em produção sem sessão, e nenhum teste
// diria uma palavra — o método responderia 200 com os dados de quem o autor
// tivesse em mente, para qualquer pessoa que soubesse o endereço.
//
// A auditoria de 01/09/2026 encontrou duas rotas públicas que estavam certas por
// desenho e uma que estava errada por esquecimento (a página do escritório, que
// não filtrava perfil restrito). A diferença entre as duas situações é
// exatamente o que este arquivo passa a registrar: **ser pública é uma decisão,
// e decisão se escreve.**
//
// Como funciona: o teste lê os controllers, classifica cada rota pela porta que
// ela usa, e exige que toda rota sem porta esteja em PUBLICAS com o motivo. Uma
// rota nova sem gate e sem linha aqui FALHA — e para fazê-la passar é preciso ou
// pôr a porta, ou declarar por escrito que ela é pública.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = __dirname

function controllers(dir: string): string[] {
  const achados: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) achados.push(...controllers(caminho))
    else if (entrada.name.endsWith('.controller.ts')) achados.push(caminho)
  }
  return achados
}

interface Rota {
  metodo: string
  caminho: string
  handler: string
  corpo: string
}

function rotasDe(arquivo: string): Rota[] {
  const fonte = readFileSync(arquivo, 'utf8')
  const prefixo = /@Controller\('([^']*)'\)/.exec(fonte)?.[1] ?? ''
  const marcador = /@(Get|Post|Put|Patch|Delete)\((?:'([^']*)')?\)/g
  const pedacos: { metodo: string; caminho: string; inicio: number }[] = []
  for (const m of fonte.matchAll(marcador)) {
    pedacos.push({ metodo: m[1]!, caminho: m[2] ?? '', inicio: m.index! })
  }
  return pedacos.map((p, i) => {
    const fim = pedacos[i + 1]?.inicio ?? fonte.length
    const corpo = fonte.slice(p.inicio, fim)
    return {
      metodo: p.metodo,
      caminho: [prefixo, p.caminho].filter(Boolean).join('/'),
      handler: /\n\s{2}(?:async\s+)?(\w+)\s*\(/.exec(corpo)?.[1] ?? '?',
      corpo,
    }
  })
}

const TODAS = controllers(SRC).flatMap(rotasDe)

/** Chama a porta da sessão do advogado? */
const TEM_SESSAO = (c: string) => /requireUser\(|resolveUser\(|sessaoAtual\(/.test(c)
/** Lê a sessão sem exigi-la (a rota atende logado e deslogado, com respostas diferentes)? */
const SESSAO_OPCIONAL = (c: string) => /userIdFrom\(/.test(c)
/** É do painel? Quem cobra essas é admin-rotas.spec.ts. */
const DO_PAINEL = (r: Rota) => r.caminho === 'admin' || r.caminho.startsWith('admin/')

/**
 * As rotas que atendem QUEM NÃO ESTÁ LOGADO, e por quê.
 *
 * A chave é "MÉTODO /caminho". O valor não é decoração: é o argumento de que
 * abrir esta rota foi decisão, e é o que a próxima pessoa lê antes de copiar o
 * desenho para uma rota nova.
 */
const PUBLICAS: Record<string, string> = {
  // --- Porta de entrada: é onde a sessão nasce, não pode exigir sessão --------
  'POST /auth/signup': 'cadastro; teto de 8/h por IP e enumeração mitigada',
  'POST /auth/login': 'login; teto por IP e por conta, erro genérico, timing pago',
  'POST /auth/logout':
    'sair é intenção que nunca pode ficar presa; responde 204 mesmo sem sessão, e o CSRF é dispensado de propósito',

  // --- Credencial conferida sem abrir sessão ---------------------------------
  'POST /appeals/contestar':
    'o canal de quem a sanção impediu de entrar: confere e-mail e senha e NÃO abre sessão. Bloqueá-lo com login seria tirar o direito de contestar justamente de quem foi suspenso',
  'POST /billing/webhook':
    'quem chama é o servidor do provedor, sem cookie e sem navegador: a fronteira é a assinatura HMAC sobre o corpo cru, conferida antes de o corpo virar qualquer coisa',

  // --- Leitura pública: é o produto ------------------------------------------
  'GET /profiles/:slug':
    'a página do advogado é para ser lida por qualquer pessoa. Passa por perfilVisivelAoPublico() e por toPublic(), que tira nota de moderação, situação de cobrança e o endereço que o dono escondeu',
  'GET /profiles/:slug/avatar':
    'a foto que alimenta a prévia de link; mesma regra de visibilidade, e serve bytes — nunca redireciona',
  'GET /firms/:slug':
    'a página institucional da sociedade; lista só membro cujo perfil passa em perfilVisivelAoPublico()',
  'GET /directory': 'busca pública; devolve endereço de foto, nunca os bytes, e o termo tem teto',
  'GET /sitemap': 'só slug e data, para o /sitemap.xml da borda; mesma regra de visibilidade',
  'GET /health': 'sonda de disponibilidade; não lê banco nem devolve dado de ninguém',

  // --- Escrita pública, deliberadamente --------------------------------------
  'POST /profiles/:slug/evento':
    'quem toca no botão do perfil é o visitante, que não tem conta nem deve ter. Responde 204 sempre — inclusive quando recusa — para não virar oráculo de quais slugs existem. O IP é só chave de limite e não é gravado',
  'POST /profiles/:slug/report':
    'denunciar não pode exigir conta: quem vê publicidade irregular costuma ser cliente, não advogado. Teto por IP e por IP+perfil',

  // --- Serviço de apoio -------------------------------------------------------
  'GET /geo/cep/:cep':
    'o onboarding preenche endereço antes de a conta existir. Só dígitos, dois hosts fixos, nada gravado; teto por IP para não virarmos proxy de varredura do ViaCEP',

  // --- Sessão OPCIONAL: a rota atende os dois lados ---------------------------
  'POST /ai/generate':
    'o Free sem conta gera bio e área. O plano vem do BANCO quando há sessão, nunca do corpo; sem sessão é free, que é o mais restrito',
  'GET /profiles/slug-available':
    'o onboarding confere o endereço antes de haver conta. Sem sessão, o dono nunca casa, então a resposta é só "livre ou ocupado"',

  // --- Porta que delega a verificação -----------------------------------------
  'POST /account/anonymize':
    'apelido de DELETE /account: o corpo do método chama remove(), que exige sessão E a senha. A porta está lá, uma chamada abaixo',
}

describe('as portas da API', () => {
  it('achou as rotas (o teste não está passando por não achar nada)', () => {
    expect(TODAS.length).toBeGreaterThan(40)
  })

  it('toda rota fora do painel tem porta, ou está declarada como pública', () => {
    const semPorta: string[] = []
    for (const r of TODAS) {
      if (DO_PAINEL(r)) continue
      if (TEM_SESSAO(r.corpo) || SESSAO_OPCIONAL(r.corpo)) continue
      const chave = `${r.metodo.toUpperCase()} /${r.caminho}`
      if (PUBLICAS[chave]) continue
      semPorta.push(`${chave} (${r.handler})`)
    }
    expect(
      semPorta,
      'rota sem sessão e sem justificativa em PUBLICAS — ponha a porta, ou escreva por que ela não tem',
    ).toEqual([])
  })

  it('a lista de públicas não guarda rota que deixou de existir', () => {
    // Uma justificativa órfã é pior que nenhuma: ela descreve um desenho que não
    // existe mais, e a próxima pessoa a lê como se descrevesse.
    const existentes = new Set(TODAS.map((r) => `${r.metodo.toUpperCase()} /${r.caminho}`))
    const orfas = Object.keys(PUBLICAS).filter((k) => !existentes.has(k))
    expect(orfas, 'PUBLICAS descreve rota que não existe mais').toEqual([])
  })

  it('toda justificativa diz alguma coisa', () => {
    for (const [rota, motivo] of Object.entries(PUBLICAS)) {
      expect(motivo.length, `${rota} tem justificativa vazia demais`).toBeGreaterThan(30)
    }
  })

  it('nenhuma rota pública ESCREVE sem uma barreira própria', () => {
    // Escrita sem sessão precisa de outra coisa no lugar dela: assinatura,
    // credencial conferida na mão, ou teto de tentativas. Uma escrita pública e
    // sem teto é um formulário de spam com o nosso nome.
    const escreve = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
    for (const r of TODAS) {
      if (DO_PAINEL(r)) continue
      const chave = `${r.metodo.toUpperCase()} /${r.caminho}`
      if (!PUBLICAS[chave] || !escreve.has(r.metodo.toUpperCase())) continue
      if (TEM_SESSAO(r.corpo) || SESSAO_OPCIONAL(r.corpo)) continue
      const temBarreira =
        /RateLimit\(/.test(r.corpo) || // teto de tentativas
        /conferirAssinatura|rawBody/.test(r.corpo) || // HMAC do webhook
        /this\.remove\(/.test(r.corpo) || // delega para uma porta com sessão
        // Logout: a barreira é a própria credencial. `sessions.encerrar` só
        // apaga a linha depois de `credencialConfere` — sem o cookie certo, a
        // rota limpa o navegador de quem chamou e não toca em sessão nenhuma.
        // Sem isso, adivinhar um id de sessão derrubaria a de outra pessoa.
        /sessions\.encerrar\(/.test(r.corpo) ||
        // Denúncia: o teto está no SERVIÇO e não no controller, porque uma das
        // duas chaves é `ip + perfil` — e o id do perfil só existe depois de
        // resolver o slug. Ver ModerationService.createReport.
        /moderation\.createReport\(/.test(r.corpo)
      expect(temBarreira, `${chave} escreve sem sessão e sem barreira nenhuma`).toBe(true)
    }
  })
})

describe('o que nunca pode sair numa resposta', () => {
  it('nenhum controller devolve hash de senha, segredo de sessão ou de TOTP', () => {
    // Não é hipótese: o dia em que alguém trocar um `select` por um `include`
    // numa consulta de User ou de AdminUser, a coluna `password` viaja junto.
    // Este teste não alcança os serviços, mas alcança a camada que responde.
    //
    // Os comentários saem antes: `password` aparece legitimamente no comentário
    // que descreve o CORPO de POST /admin/login — recebê-la é o trabalho dessa
    // rota. O que não pode existir é código que a devolva.
    const semComentario = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const proibido = /\b(passwordHash|tokenHash|totpSecret)\b|\bpassword\s*:\s*true\b/
    for (const arquivo of controllers(SRC)) {
      const codigo = semComentario(readFileSync(arquivo, 'utf8'))
      expect(proibido.test(codigo), `${arquivo} menciona credencial numa resposta`).toBe(false)
    }
  })
})
