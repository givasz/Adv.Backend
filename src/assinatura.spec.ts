// O que a cobrança NÃO pode errar.
//
// Este é o único pedaço do dinheiro que dá para testar sem banco e sem provedor —
// e é justamente onde um erro custa caro dos dois lados: rebaixar quem pagou, ou
// entregar de graça quem não pagou. As datas são todas explícitas: `Date.now()`
// dentro de um teste de prazo é um teste que falha sozinho num fuso diferente.

import { describe, expect, it } from 'vitest'
import {
  aoCancelar,
  aoConfirmarPagamento,
  aoFalharPagamento,
  aoPausar,
  aoRetomar,
  aoTrocarPlano,
  aoVirarOPrazo,
  aoPerderOPlano,
  CARENCIA_DIAS,
  CARENCIA_ENDERECO_DIAS,
  emCortesia,
  enderecoVenceu,
  planoVigente,
  somarDias,
  TOLERANCIA_RENOVACAO_DIAS,
  venceu,
} from './assinatura'

const HOJE = new Date('2026-08-28T12:00:00.000Z')
const dias = (n: number) => somarDias(HOJE, n)

describe('plano vigente', () => {
  it('assinatura em dia entrega o plano contratado', () => {
    expect(planoVigente({ plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(10) }, HOJE)).toBe(
      'premium',
    )
  })

  it('cartão recusado NÃO rebaixa: a carência ainda vale', () => {
    // É o cenário mais comum de todos — cartão vencido — e o mais caro de errar.
    const p = { plan: 'premium', planStatus: 'past_due', graceUntil: dias(5) }
    expect(planoVigente(p, HOJE)).toBe('premium')
    expect(emCortesia(p, HOJE)).toBe(true)
  })

  it('carência esgotada rebaixa', () => {
    expect(planoVigente({ plan: 'premium', planStatus: 'past_due', graceUntil: dias(-1) }, HOJE)).toBe(
      'free',
    )
  })

  it('quem pagou o mês tem o mês, mesmo depois de cancelar', () => {
    const p = { plan: 'pro', planStatus: 'canceled', currentPeriodEnd: dias(12) }
    expect(planoVigente(p, HOJE)).toBe('pro')
    expect(emCortesia(p, HOJE)).toBe(true)
  })

  it('cancelada com o período vencido cai para o Free', () => {
    expect(planoVigente({ plan: 'pro', planStatus: 'canceled', currentPeriodEnd: dias(-1) }, HOJE)).toBe(
      'free',
    )
  })

  it('webhook de renovação atrasado não rebaixa quem pagou', () => {
    // O período venceu ontem e a confirmação ainda não chegou. Sem a tolerância,
    // um atraso de fila no provedor tiraria o perfil de alguém em dia do ar.
    const ontem = { plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(-1) }
    expect(planoVigente(ontem, HOJE)).toBe('premium')
    const velho = { plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(-TOLERANCIA_RENOVACAO_DIAS - 1) }
    expect(planoVigente(velho, HOJE)).toBe('free')
  })

  it('a falha de cobrança não encurta um mês já pago', () => {
    // Carência de 7 dias, mas o mês pago ainda tem 20: vale o maior dos dois.
    const p = { plan: 'pro', planStatus: 'past_due', graceUntil: dias(2), currentPeriodEnd: dias(20) }
    expect(planoVigente(p, HOJE)).toBe('pro')
  })

  it('sanção que pausa a cobrança não retira acesso', () => {
    // Quem tira a página do ar é a moderação, por outra porta e com prazo. Se a
    // pausa também rebaixasse, a sanção viraria um rebaixamento disfarçado — sem
    // prazo e sem contestação (docs/politica-de-sancoes.md).
    const p = { plan: 'premium', planStatus: 'paused', currentPeriodEnd: dias(-90) }
    expect(planoVigente(p, HOJE)).toBe('premium')
    expect(venceu(p, HOJE)).toBe(false)
  })

  it('Free é Free em qualquer situação de cobrança', () => {
    expect(planoVigente({ plan: 'free', planStatus: 'past_due', graceUntil: dias(-9) }, HOJE)).toBe('free')
  })

  it('assinatura ativa sem prazo conhecido não vence sozinha', () => {
    // É o estado da plataforma em teste (sem cobrança) e o do plano concedido por
    // escritório. Vencer aqui rebaixaria todo mundo no primeiro deploy.
    expect(planoVigente({ plan: 'premium', planStatus: 'active' }, HOJE)).toBe('premium')
  })

  it('lixo no status não libera plano: cai no caminho de assinatura ativa', () => {
    expect(planoVigente({ plan: 'pro', planStatus: 'sei-la', currentPeriodEnd: dias(-30) }, HOJE)).toBe(
      'free',
    )
  })
})

describe('transições', () => {
  it('pagamento confirmado zera a carência', () => {
    const patch = aoConfirmarPagamento('premium', dias(30))
    expect(patch).toMatchObject({ plan: 'premium', planStatus: 'active', graceUntil: null })
  })

  it('a carência abre UMA vez por episódio', () => {
    // O provedor tenta de novo várias vezes. Se cada tentativa frustrada empurrasse
    // o prazo, a carência nunca venceria e o plano seria eterno.
    const primeira = aoFalharPagamento({ plan: 'pro', planStatus: 'active' }, HOJE)
    expect(primeira.graceUntil).toEqual(somarDias(HOJE, CARENCIA_DIAS))
    const segunda = aoFalharPagamento(
      { plan: 'pro', planStatus: 'past_due', graceUntil: primeira.graceUntil },
      somarDias(HOJE, 3),
    )
    expect(segunda.graceUntil).toEqual(primeira.graceUntil)
  })

  it('cancelar preserva o período pago e derruba um rebaixamento agendado', () => {
    const patch = aoCancelar({ plan: 'premium', currentPeriodEnd: dias(9), planScheduled: 'pro' }, HOJE)
    expect(patch).toMatchObject({ planStatus: 'canceled', planScheduled: null })
    expect(patch.currentPeriodEnd).toEqual(dias(9))
  })

  it('pausar e retomar não mexem no plano contratado', () => {
    expect(aoPausar()).toEqual({ planStatus: 'paused' })
    expect(aoRetomar()).toEqual({ planStatus: 'active' })
  })
})

describe('troca de plano pedida pela pessoa', () => {
  it('subir vale na hora', () => {
    const patch = aoTrocarPlano({ plan: 'free', planStatus: 'active' }, 'pro', HOJE)
    expect(patch).toMatchObject({ plan: 'pro', planStatus: 'active' })
  })

  it('subir desfaz um rebaixamento que estava agendado', () => {
    // Sem isto, quem desistiu de descer e comprou o plano maior seria rebaixado no
    // fim do mês assim mesmo.
    const patch = aoTrocarPlano(
      { plan: 'pro', planStatus: 'active', planScheduled: 'free', currentPeriodEnd: dias(8) },
      'premium',
      HOJE,
    )
    expect(patch).toMatchObject({ plan: 'premium', planScheduled: null })
  })

  it('descer é AGENDADO para o fim do período pago', () => {
    // Cobrar um mês de Max e entregar Pro no dia seguinte é vender o que não se
    // entrega — e é o que acontecia até 28/08/2026.
    const patch = aoTrocarPlano(
      { plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(15) },
      'pro',
      HOJE,
    )
    expect(patch).toEqual({ planScheduled: 'pro' })
    // E o vigente NÃO muda enquanto o mês não vira.
    expect(planoVigente({ plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(15) }, HOJE)).toBe(
      'premium',
    )
  })

  it('sem período pago, descer vale já (é o caso da plataforma em teste)', () => {
    const patch = aoTrocarPlano({ plan: 'premium', planStatus: 'active' }, 'pro', HOJE)
    expect(patch).toMatchObject({ plan: 'pro', planScheduled: null })
  })

  it('cair para o Free é cancelamento: o mês pago é respeitado', () => {
    const patch = aoTrocarPlano(
      { plan: 'premium', planStatus: 'active', currentPeriodEnd: dias(20) },
      'free',
      HOJE,
    )
    expect(patch).toMatchObject({ planStatus: 'canceled' })
    // `plan` NÃO vira free agora: quem pagou o mês tem o mês.
    expect(patch.plan).toBeUndefined()
    expect(planoVigente({ plan: 'premium', ...patch } as any, HOJE)).toBe('premium')
  })

  it('trocar para o mesmo plano não faz nada', () => {
    expect(aoTrocarPlano({ plan: 'pro' }, 'pro', HOJE)).toEqual({})
  })
})

describe('varredura (o que vence sozinho)', () => {
  it('aplica o rebaixamento agendado quando o período vira', () => {
    const patch = aoVirarOPrazo(
      { plan: 'premium', planStatus: 'active', planScheduled: 'pro', currentPeriodEnd: dias(-1) },
      HOJE,
    )
    expect(patch).toMatchObject({ plan: 'pro', planScheduled: null })
  })

  it('não aplica antes da hora', () => {
    expect(
      aoVirarOPrazo(
        { plan: 'premium', planStatus: 'active', planScheduled: 'pro', currentPeriodEnd: dias(3) },
        HOJE,
      ),
    ).toBeNull()
  })

  it('rebaixa quem venceu de vez', () => {
    const patch = aoVirarOPrazo({ plan: 'premium', planStatus: 'past_due', graceUntil: dias(-1) }, HOJE)
    expect(patch).toMatchObject({ plan: 'free', planStatus: 'canceled' })
  })

  it('é idempotente: rodar de novo não faz nada', () => {
    const vencido = { plan: 'premium', planStatus: 'past_due', graceUntil: dias(-1) }
    const patch = aoVirarOPrazo(vencido, HOJE)!
    expect(aoVirarOPrazo({ ...vencido, ...patch } as any, HOJE)).toBeNull()
  })

  it('não toca em quem está em dia, nem em quem está na carência', () => {
    expect(aoVirarOPrazo({ plan: 'pro', planStatus: 'active', currentPeriodEnd: dias(10) }, HOJE)).toBeNull()
    expect(aoVirarOPrazo({ plan: 'pro', planStatus: 'past_due', graceUntil: dias(2) }, HOJE)).toBeNull()
  })

  it('não rebaixa assinatura pausada por sanção, por mais velha que esteja', () => {
    expect(
      aoVirarOPrazo({ plan: 'premium', planStatus: 'paused', currentPeriodEnd: dias(-400) }, HOJE),
    ).toBeNull()
  })
})

describe('o prazo do endereço', () => {
  // Cair para o Free devolve o endereço ao padrão "nome-1234". Isso é o que dá
  // peso ao rebaixamento — mas só depois de uma semana avisada, porque o endereço
  // está impresso em cartão de visita e indexado no Google.

  it('nasce uma semana à frente', () => {
    expect(aoPerderOPlano(HOJE).getTime()).toBe(dias(CARENCIA_ENDERECO_DIAS).getTime())
  })

  it('vence só depois da data, e só para quem está mesmo no Free', () => {
    const noFree = { plan: 'free', planStatus: 'canceled' }
    expect(enderecoVenceu({ ...noFree, slugGraceUntil: dias(-1) }, HOJE)).toBe(true)
    expect(enderecoVenceu({ ...noFree, slugGraceUntil: dias(1) }, HOJE)).toBe(false)
  })

  it('sem prazo marcado, nada vence — é o caso de todo mundo', () => {
    expect(enderecoVenceu({ plan: 'free', slugGraceUntil: null }, HOJE)).toBe(false)
    expect(enderecoVenceu({ plan: 'pro', planStatus: 'active' }, HOJE)).toBe(false)
  })

  it('quem voltou a pagar não perde o endereço, mesmo com o prazo vencido', () => {
    expect(
      enderecoVenceu(
        { plan: 'pro', planStatus: 'active', currentPeriodEnd: dias(20), slugGraceUntil: dias(-5) },
        HOJE,
      ),
    ).toBe(false)
  })

  it('na carência da COBRANÇA o endereço nem entra em jogo: o plano ainda vale', () => {
    // O prazo do endereço só começa a correr quando o plano já caiu — os dois
    // prazos são em sequência, nunca em paralelo. Somados, são duas semanas entre
    // o cartão recusado e o link mudar.
    expect(
      enderecoVenceu(
        { plan: 'premium', planStatus: 'past_due', graceUntil: dias(2), slugGraceUntil: dias(-1) },
        HOJE,
      ),
    ).toBe(false)
  })
})
