import { describe, expect, it } from 'vitest'
import { enderecoCols, enderecoDaLinha } from './sanitize'

// A fronteira do endereço. O objeto `address` chega como JSON livre no corpo do
// PUT do perfil e do escritório — tipo, tamanho e formato do CEP só passam a
// existir aqui.

describe('enderecoCols: do corpo para as colunas', () => {
  it('grava o CEP só com dígitos', () => {
    expect(enderecoCols({ cep: '01310-100' }).addressZip).toBe('01310100')
  })

  it('CEP incompleto ou com lixo vira null — meio CEP não leva a lugar nenhum', () => {
    expect(enderecoCols({ cep: '0131010' }).addressZip).toBeNull()
    expect(enderecoCols({ cep: 'abcdefgh' }).addressZip).toBeNull()
    expect(enderecoCols({ cep: '013101001234' }).addressZip).toBeNull()
  })

  it('apara e corta texto no teto de cada campo', () => {
    const c = enderecoCols({
      rua: `  ${'a'.repeat(200)}  `,
      numero: 'n'.repeat(50),
      complemento: 'c'.repeat(200),
      bairro: 'b'.repeat(200),
    })
    expect(c.addressStreet).toHaveLength(120)
    expect(c.addressNumber).toHaveLength(20)
    expect(c.addressComplement).toHaveLength(60)
    expect(c.addressDistrict).toHaveLength(80)
  })

  it('tipo errado vira null em vez de derrubar a requisição', () => {
    const c = enderecoCols({ rua: 42, numero: null, bairro: { a: 1 }, complemento: [] })
    expect(c.addressStreet).toBeNull()
    expect(c.addressNumber).toBeNull()
    expect(c.addressDistrict).toBeNull()
    expect(c.addressComplement).toBeNull()
  })

  it('corpo ausente ou de outro tipo devolve endereço vazio e público', () => {
    for (const entrada of [undefined, null, 'texto', 7, []]) {
      const c = enderecoCols(entrada)
      expect(c.addressStreet).toBeNull()
      expect(c.addressPublic).toBe(true)
    }
  })

  it('publico só é falso quando pedido explicitamente', () => {
    expect(enderecoCols({}).addressPublic).toBe(true)
    expect(enderecoCols({ publico: undefined }).addressPublic).toBe(true)
    // Só o `false` literal desliga: `0`, `''` e `null` num JSON de cliente são
    // quase sempre campo não preenchido, não uma escolha de esconder.
    expect(enderecoCols({ publico: 0 }).addressPublic).toBe(true)
    expect(enderecoCols({ publico: false }).addressPublic).toBe(false)
  })
})

describe('enderecoDaLinha: das colunas para a resposta', () => {
  const vazio = {
    addressZip: null,
    addressStreet: null,
    addressNumber: null,
    addressComplement: null,
    addressDistrict: null,
    addressPublic: true,
  }

  it('linha sem endereço nenhum não vira objeto vazio na resposta', () => {
    expect(enderecoDaLinha(vazio)).toBeUndefined()
  })

  it('devolve só o que existe, com o interruptor junto', () => {
    expect(enderecoDaLinha({ ...vazio, addressStreet: 'Av. Paulista', addressZip: '01310100' })).toEqual({
      rua: 'Av. Paulista',
      cep: '01310100',
      publico: true,
    })
  })

  it('o endereço escondido continua VOLTANDO para o dono — escondido', () => {
    // A resposta não censura: quem escondeu tem de continuar vendo o que
    // escondeu no editor. Quem decide não desenhar é a página.
    const r = enderecoDaLinha({ ...vazio, addressStreet: 'Rua X', addressPublic: false })
    expect(r).toEqual({ rua: 'Rua X', publico: false })
  })

  it('sobrevive a colunas ausentes (linha vinda de select parcial)', () => {
    expect(enderecoDaLinha({})).toBeUndefined()
  })
})
