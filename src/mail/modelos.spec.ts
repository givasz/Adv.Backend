// Os e-mails que a plataforma manda. O que não pode regredir:
//
//   • quem está falando aparece em todos (razão social e CNPJ);
//   • texto escrito por uma pessoa nunca vira marcação;
//   • todo link é do nosso site, e o token vai depois do `#`;
//   • o recibo da denúncia não repete o perfil denunciado;
//   • nenhum e-mail é publicidade.

import { describe, expect, it } from 'vitest'
import { MODELOS, PRIORIDADE, renderizar, type Modelo } from './modelos'
import { OPERADOR } from '../legal/termos'

const SITE = 'https://site.test'
const TOKEN = 'A'.repeat(43)

const DADOS: Record<Modelo, Record<string, unknown>> = {
  'confirmar-email': { token: TOKEN, nome: 'Marina' },
  'redefinir-senha': { token: TOKEN },
  'senha-alterada': { quando: '2026-09-12T17:05:00Z', porLink: true },
  'denuncia-recebida': {},
  'denuncia-analisada': { enviadaEm: '2026-09-10T12:00:00Z' },
  'moderacao-decisao': {
    acao: 'restrict',
    motivo: 'Promessa de resultado na apresentação.',
    ate: '2026-10-12T12:00:00Z',
    contestarAte: '2026-09-27T12:00:00Z',
    cobrancaPausada: true,
  },
  'conta-suspensa': { motivo: 'Inscrição de terceiro.', ate: '2026-10-01T12:00:00Z' },
  'conta-reativada': {},
  'conta-encerrada': { motivo: 'Fraude confirmada.', contestarAte: '2026-10-12T12:00:00Z', planoPago: true },
  'contestacao-recebida': { respondeAte: '2026-09-22T12:00:00Z' },
  'contestacao-respondida': { aceita: false, resposta: 'A frase continua prometendo resultado.' },
  'convite-escritorio': { escritorio: 'Andrade & Vieira Advogados', papel: 'member' },
  'termos-atualizados': { versao: '2026-09-12' },
}

const todos = () => MODELOS.map((m) => ({ modelo: m, ...renderizar(m, DADOS[m], { site: SITE }) }))

describe('os modelos de e-mail', () => {
  it('todo modelo monta assunto, texto e HTML, e tem prioridade', () => {
    for (const r of todos()) {
      expect(r.assunto.length, r.modelo).toBeGreaterThan(5)
      expect(r.texto.length, r.modelo).toBeGreaterThan(40)
      expect(r.html.startsWith('<!doctype html>'), r.modelo).toBe(true)
      expect([0, 1, 2]).toContain(PRIORIDADE[r.modelo])
    }
  })

  it('todo e-mail diz quem está falando', () => {
    for (const r of todos()) {
      expect(r.texto, r.modelo).toContain(OPERADOR.cnpj)
      expect(r.html, r.modelo).toContain(OPERADOR.cnpj)
    }
  })

  it('nenhum e-mail é publicidade', () => {
    for (const r of todos()) {
      expect(r.texto, r.modelo).not.toMatch(/\b(promoç|desconto|oferta|assine|upgrade|plano max|grátis)/i)
    }
  })

  it('texto escrito por uma pessoa não vira marcação', () => {
    const m = renderizar('moderacao-decisao', { acao: 'warn', motivo: '<img src=x onerror=alert(1)>' }, { site: SITE })
    expect(m.html).not.toContain('<img')
    expect(m.html).toContain('&lt;img')
    const c = renderizar('confirmar-email', { token: TOKEN, nome: '"><script>alert(1)</script>' }, { site: SITE })
    expect(c.html).not.toContain('<script>')
  })

  it('todo link sai do endereço do site, e o token vai depois do #', () => {
    for (const r of todos()) {
      for (const [, href] of r.html.matchAll(/href="([^"]+)"/g)) {
        expect(href!.startsWith(`${SITE}/`), `${r.modelo}: ${href}`).toBe(true)
      }
    }
    const r = renderizar('redefinir-senha', { token: TOKEN }, { site: SITE })
    expect(r.texto).toContain(`${SITE}/redefinir-senha#t=${TOKEN}`)
    expect(r.html).not.toMatch(/\?[^"]*t=/)
  })

  it('os dados nunca trazem endereço: um "link" posto neles é ignorado', () => {
    const r = renderizar('termos-atualizados', { versao: '2026-09-12', link: 'https://golpe.test' }, { site: SITE })
    expect(r.html).not.toContain('golpe.test')
    expect(r.texto).not.toContain('golpe.test')
  })

  it('link obrigatório sem token válido: recusa em vez de mandar botão morto', () => {
    expect(() => renderizar('redefinir-senha', {}, { site: SITE })).toThrow()
    expect(() => renderizar('confirmar-email', { token: 'curto' }, { site: SITE })).toThrow()
  })

  it('o recibo da denúncia não repete o perfil nem o motivo', () => {
    // Qualquer pessoa digita o e-mail de outra no formulário: um "recebemos sua
    // denúncia contra Fulana" cairia na caixa errada.
    const r = renderizar('denuncia-recebida', { perfil: 'Dra. Fulana', motivo: 'captação' }, { site: SITE })
    expect(r.texto).not.toContain('Fulana')
    expect(r.texto).not.toContain('captação')
  })

  it('a data da versão dos Termos não volta um dia no fuso de Brasília', () => {
    expect(renderizar('termos-atualizados', { versao: '2026-09-12' }, { site: SITE }).texto).toContain('12/09/2026')
  })

  it('hora sai no fuso de Brasília', () => {
    const r = renderizar('senha-alterada', { quando: '2026-09-12T02:30:00Z' }, { site: SITE })
    expect(r.texto).toContain('11/09/2026 às 23:30')
  })

  it('medida desconhecida não vira e-mail genérico', () => {
    expect(() => renderizar('moderacao-decisao', { acao: 'banir' }, { site: SITE })).toThrow()
    expect(() => renderizar('nao-existe', {}, { site: SITE })).toThrow()
  })

  it('ao liberar o perfil, o motivo interno não vai no e-mail', () => {
    const r = renderizar('moderacao-decisao', { acao: 'clear', motivo: 'nota interna do painel' }, { site: SITE })
    expect(r.texto).not.toContain('nota interna')
  })

  it('convite de escritório: o nome digitado não vai no assunto nem vira marcação', () => {
    // Quem cria o escritório escolhe o nome, e o convite vai para qualquer
    // endereço que ele digitar: o nome é a isca perfeita se chegar ao assunto.
    const isca = 'Seu cartão foi bloqueado <b>clique aqui</b>'
    const r = renderizar('convite-escritorio', { escritorio: isca, papel: 'member' }, { site: SITE })
    expect(r.assunto).not.toContain('cartão')
    expect(r.html).not.toContain('<b>clique')
    expect(r.texto).toContain('Escritório:')
  })

  it('convite de escritório: o mesmo texto para quem tem conta e para quem não tem', () => {
    const r = renderizar('convite-escritorio', { escritorio: 'Andrade & Vieira', papel: 'member' }, { site: SITE })
    expect(r.texto).toContain('Se você já tem conta com este e-mail')
    expect(r.texto).toContain('Se ainda não tem')
    expect(r.texto).toMatch(/não confere escritórios nem inscrições/)
    // Quem recebe pode não ter conta: o rodapé diz o motivo certo.
    expect(r.texto).toMatch(/um escritório informou este endereço/)
    expect(r.texto).not.toMatch(/trata da sua conta/)
  })

  it('convite de escritório: diz o que administrar abre, e sem nome não sai', () => {
    const admin = renderizar('convite-escritorio', { escritorio: 'Andrade & Vieira', papel: 'admin' }, { site: SITE })
    expect(admin.texto).toMatch(/administrar a página do escritório/)
    expect(() => renderizar('convite-escritorio', { papel: 'member' }, { site: SITE })).toThrow()
  })
})
