// A tabela de permissões do painel.
//
// Ela é curta e parece óbvia — e é exatamente por isso que precisa de teste. Um
// papel a mais numa linha de `PERMISSOES` é indistinguível de um erro de
// digitação na revisão, e o efeito é quem responde suporte passar a poder tirar
// perfis do ar sem que nada na tela mude.

import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLES,
  PERMISSOES,
  PERMISSOES_DE_DECISAO,
  PERMISSOES_LISTA,
  decide,
  exigeSegundoFator,
  isAdminRole,
  permissoesDe,
  pode,
  ROLE_DESCRICAO,
  ROLE_LABEL,
  type Permissao,
} from './admin-roles'

describe('a tabela', () => {
  it('só cita papéis que existem', () => {
    for (const [permissao, papeis] of Object.entries(PERMISSOES)) {
      for (const papel of papeis) {
        expect(isAdminRole(papel), `${permissao} cita "${papel}"`).toBe(true)
      }
    }
  })

  it('todo papel tem nome e descrição para a tela', () => {
    for (const papel of ADMIN_ROLES) {
      expect(ROLE_LABEL[papel]).toBeTruthy()
      expect(ROLE_DESCRICAO[papel]).toBeTruthy()
    }
  })

  it('toda permissão de decisão existe na tabela', () => {
    for (const p of PERMISSOES_DE_DECISAO) {
      expect(PERMISSOES_LISTA).toContain(p)
    }
  })
})

describe('o corte entre consultar e decidir', () => {
  it('só leitura não decide NADA', () => {
    for (const p of PERMISSOES_DE_DECISAO) {
      expect(pode('readonly', p), `readonly não pode ${p}`).toBe(false)
    }
  })

  it('quem atende suporte não tira perfil do ar', () => {
    expect(pode('support', 'moderacao:ler')).toBe(true)
    expect(pode('support', 'moderacao:decidir')).toBe(false)
  })

  it('só o responsável mexe em administradores', () => {
    for (const papel of ADMIN_ROLES) {
      expect(pode(papel, 'admins:gerir')).toBe(papel === 'owner')
    }
  })

  it('o responsável pode tudo — senão o painel se tranca por fora', () => {
    for (const p of PERMISSOES_LISTA) expect(pode('owner', p), p).toBe(true)
  })

  it('todo papel consegue ao menos abrir o painel', () => {
    for (const papel of ADMIN_ROLES) expect(pode(papel, 'painel:abrir')).toBe(true)
  })
})

describe('falha fechada', () => {
  it('papel desconhecido não tem permissão nenhuma', () => {
    for (const p of PERMISSOES_LISTA) {
      expect(pode('gerente', p)).toBe(false)
      expect(pode(undefined, p)).toBe(false)
      expect(pode('', p)).toBe(false)
    }
    expect(permissoesDe('gerente')).toEqual([])
  })

  it('permissão inexistente é negada em vez de estourar', () => {
    expect(pode('owner', 'moderacao:apagar-tudo' as Permissao)).toBe(false)
  })
})

describe('segundo fator', () => {
  it('é exigido de quem decide sobre perfis, não de quem atende', () => {
    expect(exigeSegundoFator('owner')).toBe(true)
    expect(exigeSegundoFator('moderator')).toBe(true)
    // De propósito: exigir TOTP de quem só atende empurraria a equipe a
    // compartilhar um login — o problema que esta fase veio resolver.
    expect(exigeSegundoFator('support')).toBe(false)
    expect(exigeSegundoFator('readonly')).toBe(false)
  })

  it('todo papel que exige segundo fator decide alguma coisa', () => {
    for (const papel of ADMIN_ROLES) {
      if (!exigeSegundoFator(papel)) continue
      expect(PERMISSOES_LISTA.some((p) => decide(p) && pode(papel, p)), papel).toBe(true)
    }
  })
})
