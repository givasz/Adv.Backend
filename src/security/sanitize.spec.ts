import { describe, expect, it } from 'vitest'
import {
  clampList,
  clampOrNull,
  clampText,
  oneOf,
  safeEmail,
  safeHexColor,
  safeHostname,
  safeImageSrc,
  safePhone,
  safeWhatsapp,
  safeUrl,
} from './sanitize'

describe('clampText', () => {
  it('corta no teto e apara espaços', () => {
    expect(clampText('  oi  ', 10)).toBe('oi')
    expect(clampText('a'.repeat(10_000), 20)).toHaveLength(20)
  })

  it('tipo errado vira vazio em vez de derrubar a rota', () => {
    expect(clampText(42, 10)).toBe('')
    expect(clampText(null, 10)).toBe('')
    expect(clampText({ toString: () => 'x' }, 10)).toBe('')
    expect(clampText(undefined, 10)).toBe('')
  })
})

describe('clampOrNull', () => {
  it('vazio vira null', () => {
    expect(clampOrNull('   ', 10)).toBeNull()
    expect(clampOrNull('texto', 10)).toBe('texto')
  })
})

describe('safeUrl', () => {
  it('aceita http e https', () => {
    expect(safeUrl('https://exemplo.com/pagina')).toBe('https://exemplo.com/pagina')
    expect(safeUrl('http://exemplo.com')).toBe('http://exemplo.com/')
  })

  it('completa com https quando falta o esquema', () => {
    expect(safeUrl('instagram.com/adv')).toBe('https://instagram.com/adv')
  })

  it('recusa esquema que executa código', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeNull()
    expect(safeUrl('  javascript:alert(1)  ')).toBeNull()
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeUrl('vbscript:msgbox(1)')).toBeNull()
    expect(safeUrl('file:///etc/passwd')).toBeNull()
  })

  it('recusa lixo, tipo errado e URL gigante', () => {
    expect(safeUrl('')).toBeNull()
    expect(safeUrl(123)).toBeNull()
    expect(safeUrl('sem-ponto')).toBeNull()
    expect(safeUrl(`https://exemplo.com/${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe('safeImageSrc', () => {
  it('aceita data URI de imagem dentro do teto', () => {
    const uri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    expect(safeImageSrc(uri)).toBe(uri)
  })

  it('recusa data URI que não é imagem, e imagem grande demais', () => {
    expect(safeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(safeImageSrc(`data:image/jpeg;base64,${'A'.repeat(500_000)}`)).toBeNull()
  })

  it('link externo só por https', () => {
    expect(safeImageSrc('https://cdn.exemplo.com/foto.jpg')).toBe('https://cdn.exemplo.com/foto.jpg')
    expect(safeImageSrc('http://cdn.exemplo.com/foto.jpg')).toBeNull()
    expect(safeImageSrc('javascript:alert(1)')).toBeNull()
  })
})

describe('safeHexColor', () => {
  it('só hexadecimal entra', () => {
    expect(safeHexColor('#a1b2c3')).toBe('#a1b2c3')
    expect(safeHexColor('#fff')).toBe('#fff')
    expect(safeHexColor('red; background: url(http://evil)')).toBeNull()
    expect(safeHexColor('expression(alert(1))')).toBeNull()
  })
})

describe('safeHostname', () => {
  it('aceita domínio e limpa esquema/caminho', () => {
    expect(safeHostname('https://advoc.me/perfil')).toBe('advoc.me')
    expect(safeHostname('Escritorio.ADV.br')).toBe('escritorio.adv.br')
  })

  it('recusa o que não é domínio', () => {
    expect(safeHostname('localhost')).toBeNull()
    expect(safeHostname('a b.com')).toBeNull()
    expect(safeHostname('')).toBeNull()
    expect(safeHostname(7)).toBeNull()
  })
})

describe('safeEmail / safePhone', () => {
  it('confere formato', () => {
    expect(safeEmail(' Fulano@Exemplo.com ')).toBe('fulano@exemplo.com')
    expect(safeEmail('sem-arroba')).toBeNull()
    // Telefone para EXIBIR guarda a pontuação — é assim que a pessoa lê na tela.
    expect(safePhone('+55 (11) 99000-0000')).toBe('+55 (11) 99000-0000')
    expect(safePhone('<script>alert(1)</script>')).toBeNull()
  })
})

describe('safeWhatsapp — o número que vira LINK, não o que vira texto', () => {
  // Enquanto o WhatsApp usava safePhone, "+55 (11) 99000-0000" era gravado com a
  // pontuação e a URL virava `https://wa.me/+55 (11) 99000-0000?text=...`, que não
  // abre conversa nenhuma. A falha é silenciosa dos dois lados: a mensagem não
  // chega e ninguém fica sabendo. Ver frontend/src/lib/whatsapp.ts.

  it('normaliza para só dígitos, com DDI', () => {
    expect(safeWhatsapp('+55 (11) 99000-0000')).toBe('5511990000000')
    expect(safeWhatsapp('55 11 99887-7665')).toBe('5511998877665')
    expect(safeWhatsapp('5511998877665')).toBe('5511998877665')
  })

  it('completa o DDI de número brasileiro que veio sem ele', () => {
    expect(safeWhatsapp('11998877665')).toBe('5511998877665')
    expect(safeWhatsapp('011998877665')).toBe('5511998877665')
  })

  it('o que não forma número vira null — nunca um link torto', () => {
    expect(safeWhatsapp('99999')).toBeNull()
    expect(safeWhatsapp('1'.repeat(20))).toBeNull()
    expect(safeWhatsapp('<script>alert(1)</script>')).toBeNull()
    expect(safeWhatsapp('')).toBeNull()
    expect(safeWhatsapp(42)).toBeNull()
  })

  it('bate com a regra do frontend — as duas pontas normalizam igual', () => {
    // Se divergirem, o servidor grava uma coisa e o link é montado com outra.
    for (const bruto of ['+55 (11) 99000-0000', '11998877665', '5511998877665']) {
      expect(safeWhatsapp(bruto)).toBe(String(safeWhatsapp(bruto)).replace(/\D/g, ''))
    }
  })
})

describe('clampList / oneOf', () => {
  it('lista corta no teto e tipo errado vira vazia', () => {
    expect(clampList(Array.from({ length: 100 }, (_, i) => i), 5)).toHaveLength(5)
    expect(clampList('não é lista', 5)).toEqual([])
  })

  it('oneOf é allowlist', () => {
    expect(oneOf('linkedin', ['instagram', 'linkedin'] as const, 'instagram')).toBe('linkedin')
    expect(oneOf('outra', ['instagram', 'linkedin'] as const, 'instagram')).toBe('instagram')
    expect(oneOf(null, ['instagram', 'linkedin'] as const, 'instagram')).toBe('instagram')
  })
})
