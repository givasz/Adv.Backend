// A trava que percorre as próprias rotas.
//
// Duas promessas do painel são fáceis de fazer e fáceis de esquecer na rota
// número quinze: **toda rota do painel pede uma permissão que existe** e
// **toda escrita do painel deixa registro**. Nenhuma revisão humana pega isso
// de forma confiável — uma rota nova, copiada de outra, some no diff.
//
// Então o teste lê o código-fonte dos controllers e cobra as duas coisas. É o
// mesmo espírito da trava de paridade das regras da OAB: a promessa vira um
// arquivo que falha.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PERMISSOES_LISTA } from './admin-roles'

const SRC = join(__dirname, '..')

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
  arquivo: string
  metodo: string
  caminho: string
  handler: string
  corpo: string
}

const ESCREVE = new Set(['Post', 'Put', 'Patch', 'Delete'])

/** Todas as rotas de um controller, com o corpo do método que as atende. */
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
    const handler = /\n\s{2}(?:async\s+)?(\w+)\s*\(/.exec(corpo)?.[1] ?? '?'
    const caminho = [prefixo, p.caminho].filter(Boolean).join('/')
    return { arquivo, metodo: p.metodo, caminho, handler, corpo }
  })
}

const TODAS = controllers(SRC).flatMap(rotasDe)
const DO_PAINEL = TODAS.filter((r) => r.caminho === 'admin' || r.caminho.startsWith('admin/'))

/**
 * Rotas do painel que escrevem SEM chamar `registrar` no controller, porque quem
 * registra é o serviço que elas chamam. Cada uma precisa estar aqui com o motivo
 * escrito — uma rota nova só entra nesta lista por decisão consciente.
 */
const REGISTRAM_NO_SERVICO: Record<string, string> = {
  login: 'AdminService.entrar grava "sessao.abrir" com o papel de quem entrou',
  logout: 'sair não é ação sobre ninguém; o evento de segurança já cobre',
  trocarSenha: 'AdminService.trocarPropriaSenha registra',
  totpStart: 'só sorteia o segredo; nada é ligado até o passo seguinte',
  totpEnable: 'AdminService.ligarTotp registra',
  totpDisable: 'AdminService.desligarTotp registra',
  criar: 'AdminService.criarAdmin registra',
  atualizar: 'AdminService.atualizarAdmin registra',
  revogar: 'AdminService.derrubarSessoes registra',
}

describe('as rotas do painel', () => {
  it('existem (o teste não está passando por não achar nada)', () => {
    expect(DO_PAINEL.length).toBeGreaterThan(10)
  })

  it('todas pedem uma permissão que existe na tabela', () => {
    const semPermissao: string[] = []
    for (const rota of DO_PAINEL) {
      const pedidas = [...rota.corpo.matchAll(/exigir\(\s*req,\s*'([^']+)'/g)].map((m) => m[1]!)
      if (!pedidas.length) {
        // `exigirSessao` é a exceção legítima: rotas sobre a PRÓPRIA conta do
        // administrador (quem sou eu, trocar minha senha, meu segundo fator).
        // Elas não decidem nada sobre terceiros — exigir permissão nominal aqui
        // trancaria o `readonly` para fora da própria troca de senha.
        // `login` e `logout` são as duas portas que NÃO podem exigir sessão:
        // uma é onde ela nasce, a outra precisa funcionar mesmo com a sessão
        // meio perdida — sair é uma intenção que nunca pode ficar presa.
        if (/exigirSessao\(/.test(rota.corpo)) continue
        if (rota.handler === 'login' || rota.handler === 'logout') continue
        semPermissao.push(`${rota.metodo} /${rota.caminho} (${rota.handler})`)
        continue
      }
      for (const p of pedidas) {
        expect(PERMISSOES_LISTA, `${rota.caminho} pede "${p}", que não existe`).toContain(p)
      }
    }
    expect(semPermissao, 'rota do painel sem porta').toEqual([])
  })

  it('toda escrita deixa registro', () => {
    const mudas: string[] = []
    for (const rota of DO_PAINEL) {
      if (!ESCREVE.has(rota.metodo)) continue
      if (/registrar\(/.test(rota.corpo)) continue
      if (REGISTRAM_NO_SERVICO[rota.handler]) continue
      mudas.push(`${rota.metodo} /${rota.caminho} (${rota.handler})`)
    }
    expect(mudas, 'escrita do painel sem AdminAction').toEqual([])
  })

  it('toda decisão sobre alguém exige motivo escrito', () => {
    // O motivo é o texto que a pessoa afetada lê. Uma decisão sem ele é uma
    // decisão que ninguém consegue contestar.
    const decisoes = DO_PAINEL.filter(
      (r) => ESCREVE.has(r.metodo) && /exigir\(\s*req,\s*'(moderacao:decidir|suporte:responder)'/.test(r.corpo),
    )
    expect(decisoes.length).toBeGreaterThan(0)
    for (const rota of decisoes) {
      expect(/exigirMotivo\(/.test(rota.corpo), `${rota.metodo} /${rota.caminho} sem motivo`).toBe(true)
    }
  })
})

describe('fora do painel', () => {
  it('nenhum controller confere administrador na mão', () => {
    // Enquanto cada rota lia o cabeçalho por conta própria, esquecer metade da
    // verificação numa rota nova era questão de tempo. A porta é uma só.
    for (const rota of TODAS) {
      expect(
        /x-admin-token'\]\s*===|process\.env\.ADMIN_(TOKEN|PASSWORD)/.test(rota.corpo),
        `${rota.arquivo}: ${rota.handler} confere admin na mão`,
      ).toBe(false)
    }
  })
})
