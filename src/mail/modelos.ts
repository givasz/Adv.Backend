// Os e-mails que a plataforma manda — o texto de cada um, num lugar só.
//
// REGRAS QUE VALEM PARA TODOS
//
//   • Só aviso sobre a conta, sobre uma denúncia, sobre um convite de escritório
//     ou sobre os documentos legais. Nada de novidade, promoção ou "conheça o
//     plano Max": e-mail de publicidade é outro regime, e a plataforma que diz ao
//     advogado o que ele pode anunciar não pode ser a primeira a mandar anúncio
//     sem pedir.
//   • Todo dado variável passa por `esc` antes de entrar no HTML. O motivo de uma
//     sanção é texto escrito pelo administrador, e o nome é texto escrito pelo
//     próprio advogado — nenhum dos dois pode virar marcação.
//   • Texto digitado por usuário nunca vai no ASSUNTO. O assunto é o que aparece
//     na lista da caixa de entrada, com o nosso remetente ao lado: um nome de
//     escritório "Seu cartão foi bloqueado" ali seria phishing assinado por nós.
//     No corpo, esse texto vai emoldurado e rotulado (ver `destaque`).
//   • Todo link é o endereço do site (decidido no servidor) mais um caminho fixo
//     daqui. Os dados do aviso nunca trazem URL: um campo "link" nos dados seria o
//     jeito mais curto de alguém fazer a plataforma assinar um e-mail de phishing.
//   • Token vai depois do `#`. O fragmento não viaja em requisição nenhuma — não
//     entra em log de proxy, nem no cabeçalho Referer de quem a página chamar.
//   • Rodapé com quem está falando (razão social e CNPJ) e por que a pessoa
//     recebeu. Aviso de suspensão sem remetente identificado é indistinguível de golpe.
//
// Os dados chegam do banco (JSON), então cada leitura é defensiva: faltou um
// campo, o texto se ajusta; faltou o token de um link obrigatório, o modelo
// recusa — melhor não enviar do que mandar um botão que não leva a lugar nenhum.

import { OPERADOR } from '../legal/termos'
import { VALIDADE_HORAS, formatoDeToken } from '../auth/tokens-de-email'

export const MODELOS = [
  'confirmar-email',
  'redefinir-senha',
  'senha-alterada',
  'denuncia-recebida',
  'denuncia-analisada',
  'moderacao-decisao',
  'conta-suspensa',
  'conta-reativada',
  'conta-encerrada',
  'contestacao-recebida',
  'contestacao-respondida',
  'convite-escritorio',
  'termos-atualizados',
] as const

export type Modelo = (typeof MODELOS)[number]

export function modeloValido(m: unknown): m is Modelo {
  return typeof m === 'string' && (MODELOS as readonly string[]).includes(m)
}

/**
 * Ordem de saída quando a fila acumula.
 *   0 → alguém está esperando na tela (senha nova, confirmação);
 *   1 → aviso sobre a conta, com prazo correndo, ou convite recém-feito;
 *   2 → aviso em massa, que nunca passa na frente dos outros nem gasta a reserva do dia.
 */
export const PRIORIDADE: Record<Modelo, 0 | 1 | 2> = {
  'confirmar-email': 0,
  'redefinir-senha': 0,
  'senha-alterada': 0,
  'denuncia-recebida': 1,
  'denuncia-analisada': 1,
  'moderacao-decisao': 1,
  'conta-suspensa': 1,
  'conta-reativada': 1,
  'conta-encerrada': 1,
  'contestacao-recebida': 1,
  'contestacao-respondida': 1,
  'convite-escritorio': 1,
  'termos-atualizados': 2,
}

export interface Mensagem {
  assunto: string
  texto: string
  html: string
}

type Dados = Record<string, unknown>

interface Link {
  rotulo: string
  /** Caminho no site, começando por "/". Nunca um endereço inteiro. */
  caminho: string
}

/** Por que a pessoa está recebendo — é a primeira frase do rodapé. */
type Motivo = 'conta' | 'denuncia' | 'convite'

interface Corpo {
  assunto: string
  titulo: string
  paragrafos: string[]
  /** Texto escrito por uma pessoa (motivo, resposta, nome) — vai emoldurado e rotulado. */
  destaque?: { rotulo: string; texto: string }
  botao?: Link
  depois?: string[]
  links?: Link[]
  /** Padrão: `conta`. Quem denunciou e quem foi convidado podem não ter conta. */
  motivo?: Motivo
}

// ---- Leitura defensiva dos dados --------------------------------------------

const FUSO = 'America/Sao_Paulo'

function texto(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function instante(v: unknown): Date | null {
  if (!(typeof v === 'string' || v instanceof Date)) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

/** "12/09/2026", no fuso de Brasília. */
export function dia(v: unknown): string {
  const d = instante(v)
  return d ? d.toLocaleDateString('pt-BR', { timeZone: FUSO }) : ''
}

/** "12/09/2026 às 14:05 (horário de Brasília)". */
export function diaEHora(v: unknown): string {
  const d = instante(v)
  if (!d) return ''
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' })
  return `${dia(d)} às ${hora} (horário de Brasília)`
}

/**
 * Versão dos Termos ("2026-09-12") por extenso. Não passa por `Date`: meia-noite
 * UTC já é o dia ANTERIOR em Brasília, e o e-mail diria que os Termos mudaram um
 * dia antes de mudarem.
 */
function versaoPorExtenso(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto(v))
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

function exigirToken(v: unknown): string {
  if (!formatoDeToken(v)) throw new Error('modelo sem token válido')
  return v
}

function horas(n: number): string {
  return n === 1 ? '1 hora' : `${n} horas`
}

// ---- Os modelos ---------------------------------------------------------------

const PRAZO_DE_RESPOSTA =
  'Se contestar, respondemos em até 10 dias — e, sem resposta nesse prazo, a medida cai sozinha.'

const MEDIDAS_DO_PERFIL: Record<string, { assunto: string; titulo: string; efeito: string }> = {
  warn: {
    assunto: 'Aviso sobre o seu perfil no advoc.me',
    titulo: 'Registramos um aviso no seu perfil',
    efeito: 'Analisamos o seu perfil e registramos um aviso. Ele continua no ar.',
  },
  partial: {
    assunto: 'Parte do seu perfil foi ocultada',
    titulo: 'Parte do seu perfil foi ocultada',
    efeito:
      'Analisamos o seu perfil e ocultamos parte do conteúdo. O restante continua no ar, e o que ficou oculto aparece marcado no editor.',
  },
  restrict: {
    assunto: 'Seu perfil foi retirado do ar',
    titulo: 'Seu perfil foi retirado do ar',
    efeito:
      'Analisamos o seu perfil e o retiramos do ar: ele não aparece para visitantes enquanto a medida valer.',
  },
}

const CORPOS: Record<Modelo, (d: Dados) => Corpo> = {
  'confirmar-email': (d) => {
    const nome = texto(d.nome, 80)
    return {
      assunto: 'Confirme seu e-mail no advoc.me',
      titulo: 'Confirme que este e-mail é seu',
      paragrafos: [
        `${nome ? `Olá, ${nome}.` : 'Olá.'} Falta um passo na sua conta do advoc.me: confirmar que este endereço é seu.`,
        'É por ele que chegam os avisos da conta — troca de senha, decisões sobre o seu perfil e mudanças nos Termos.',
      ],
      botao: { rotulo: 'Confirmar meu e-mail', caminho: `/confirmar-email#t=${exigirToken(d.token)}` },
      depois: [
        `O link vale por ${horas(VALIDADE_HORAS.confirmar)}. Se você não criou conta no advoc.me, pode ignorar esta mensagem.`,
      ],
    }
  },

  'redefinir-senha': (d) => ({
    assunto: 'Redefinir sua senha do advoc.me',
    titulo: 'Crie uma senha nova',
    paragrafos: ['Recebemos um pedido para redefinir a senha da conta ligada a este e-mail.'],
    botao: { rotulo: 'Criar senha nova', caminho: `/redefinir-senha#t=${exigirToken(d.token)}` },
    depois: [
      `O link vale por ${horas(VALIDADE_HORAS.redefinir)} e funciona uma vez só. Ao criar a senha nova, todos os aparelhos conectados saem da conta.`,
      'Se não foi você, ignore esta mensagem: sua senha atual continua valendo.',
    ],
  }),

  'senha-alterada': (d) => {
    const quando = diaEHora(d.quando)
    return {
      assunto: 'A senha da sua conta foi alterada',
      titulo: 'Sua senha foi alterada',
      paragrafos: [
        `A senha da sua conta no advoc.me foi alterada${quando ? ` em ${quando}` : ''}.`,
        d.porLink === true
          ? 'A troca foi feita pelo link de redefinição, e todos os aparelhos saíram da conta.'
          : 'Os outros aparelhos que estavam conectados saíram da conta.',
        'Se não foi você, crie uma senha nova agora e fale com a gente pelo Suporte.',
      ],
      botao: { rotulo: 'Redefinir a senha', caminho: '/esqueci-senha' },
    }
  },

  'denuncia-recebida': () => ({
    motivo: 'denuncia',
    assunto: 'Recebemos sua denúncia',
    titulo: 'Recebemos sua denúncia',
    paragrafos: [
      'Uma denúncia sobre um perfil do advoc.me foi enviada informando este e-mail para contato. Ela entrou na fila de análise.',
      // Não repetir o perfil nem o motivo é o que impede este aviso de virar
      // arma: qualquer pessoa digita o e-mail de outra no formulário, e um
      // "recebemos sua denúncia contra Fulano" cairia na caixa errada.
      'Por segurança, não repetimos aqui o que foi denunciado. Quando a análise terminar, avisamos por este e-mail.',
      'Se você não enviou denúncia nenhuma, ignore esta mensagem.',
    ],
  }),

  'denuncia-analisada': (d) => {
    const quando = dia(d.enviadaEm)
    return {
      motivo: 'denuncia',
      assunto: 'Sua denúncia foi analisada',
      titulo: 'Sua denúncia foi analisada',
      paragrafos: [
        `A denúncia que você enviou${quando ? ` em ${quando}` : ''} foi analisada e o caso foi encerrado.`,
        'Quando a análise resulta em medida, ela aparece no próprio perfil. Avisos feitos ao profissional não são divulgados.',
        'Obrigado por ajudar a manter a publicidade da advocacia dentro das regras.',
      ],
    }
  },

  'moderacao-decisao': (d) => {
    const acao = texto(d.acao)
    if (acao === 'clear') {
      return {
        assunto: 'A medida sobre o seu perfil foi retirada',
        titulo: 'Seu perfil voltou ao normal',
        paragrafos: [
          'A medida de moderação sobre o seu perfil no advoc.me foi retirada. Nada mais fica oculto ou restrito por causa dela.',
        ],
        botao: { rotulo: 'Abrir o meu painel', caminho: '/painel' },
      }
    }
    const medida = MEDIDAS_DO_PERFIL[acao]
    if (!medida) throw new Error(`ação de moderação desconhecida: ${acao}`)
    const motivo = texto(d.motivo, 1000)
    const ate = dia(d.ate)
    const contestarAte = dia(d.contestarAte)
    return {
      assunto: medida.assunto,
      titulo: medida.titulo,
      paragrafos: [
        medida.efeito,
        ate ? `A medida vale até ${ate}.` : '',
        d.cobrancaPausada === true ? 'A cobrança do seu plano fica pausada enquanto isso.' : '',
      ].filter(Boolean),
      destaque: motivo ? { rotulo: 'Motivo', texto: motivo } : undefined,
      botao: { rotulo: 'Abrir o meu painel', caminho: '/painel' },
      depois: [
        `Você pode corrigir o conteúdo pelo editor ou contestar a decisão${contestarAte ? ` até ${contestarAte}` : ''}. ${PRAZO_DE_RESPOSTA}`,
      ],
      links: [{ rotulo: 'Contestar a decisão', caminho: '/contestar' }],
    }
  },

  'conta-suspensa': (d) => {
    const ate = dia(d.ate)
    const motivo = texto(d.motivo, 1000)
    return {
      assunto: 'Sua conta no advoc.me foi suspensa',
      titulo: 'Sua conta foi suspensa',
      paragrafos: [
        `A entrada na sua conta está bloqueada${ate ? ` até ${ate}` : ''}, e o seu perfil saiu do ar pelo mesmo período.`,
        d.cobrancaPausada === true ? 'A cobrança do seu plano fica pausada enquanto durar a suspensão.' : '',
      ].filter(Boolean),
      destaque: motivo ? { rotulo: 'Motivo', texto: motivo } : undefined,
      depois: [
        `Mesmo sem conseguir entrar, você pode contestar: basta informar seu e-mail e sua senha na página de contestação. ${PRAZO_DE_RESPOSTA}`,
      ],
      botao: { rotulo: 'Contestar a suspensão', caminho: '/contestar' },
    }
  },

  'conta-reativada': () => ({
    assunto: 'Sua conta no advoc.me foi reativada',
    titulo: 'Sua conta foi reativada',
    paragrafos: [
      'A suspensão foi retirada e você já pode entrar.',
      'Confira no painel se o seu perfil está publicado do jeito que você quer.',
    ],
    botao: { rotulo: 'Entrar na minha conta', caminho: '/entrar' },
  }),

  'conta-encerrada': (d) => {
    const motivo = texto(d.motivo, 1000)
    const contestarAte = dia(d.contestarAte)
    return {
      assunto: 'Sua conta no advoc.me foi encerrada',
      titulo: 'Sua conta foi encerrada',
      paragrafos: [
        'Sua conta foi encerrada e o seu perfil saiu do ar. O endereço público que ele usava foi liberado.',
        d.planoPago === true ? 'A assinatura foi encerrada e não haverá novas cobranças.' : '',
      ].filter(Boolean),
      destaque: motivo ? { rotulo: 'Motivo', texto: motivo } : undefined,
      depois: [
        `Você pode contestar esta decisão${contestarAte ? ` até ${contestarAte}` : ''}, informando seu e-mail e sua senha na página de contestação.`,
      ],
      botao: { rotulo: 'Contestar o encerramento', caminho: '/contestar' },
    }
  },

  'contestacao-recebida': (d) => {
    const respondeAte = dia(d.respondeAte)
    return {
      assunto: 'Recebemos sua contestação',
      titulo: 'Sua contestação foi registrada',
      paragrafos: [
        `Respondemos${respondeAte ? ` até ${respondeAte}` : ' em até 10 dias'}. Se não respondermos nesse prazo, a medida cai sozinha.`,
        'A resposta chega por este e-mail e fica registrada na página de contestação.',
      ],
      botao: { rotulo: 'Acompanhar a contestação', caminho: '/contestar' },
    }
  },

  'contestacao-respondida': (d) => {
    const resposta = texto(d.resposta, 2000)
    const aceita = d.aceita === true
    const ate = dia(d.ate)
    return {
      assunto: aceita ? 'Sua contestação foi aceita' : 'Resposta à sua contestação',
      titulo: aceita ? 'Contestação aceita' : 'A medida foi mantida',
      paragrafos: [
        aceita
          ? 'Revisamos a decisão e a medida foi retirada.'
          : `Revisamos a decisão e a medida continua valendo${ate ? ` até ${ate}` : ''}.`,
      ],
      destaque: resposta ? { rotulo: 'Resposta', texto: resposta } : undefined,
      botao: aceita ? { rotulo: 'Abrir o meu painel', caminho: '/painel' } : undefined,
    }
  },

  'convite-escritorio': (d) => {
    // O nome é do escritório, digitado por quem convidou. Sem ele não há o que
    // dizer à pessoa — e um convite "de um escritório" sem nome é convite a
    // desconfiar, com razão.
    const escritorio = texto(d.escritorio, 90)
    if (!escritorio) throw new Error('convite sem nome de escritório')
    const administra = d.papel === 'admin'
    return {
      motivo: 'convite',
      // Assunto FIXO: o nome do escritório não entra aqui (ver regras no topo).
      assunto: 'Convite para a equipe de um escritório no advoc.me',
      titulo: 'Você foi convidado para um escritório',
      paragrafos: [
        'Um escritório com página no advoc.me convidou este e-mail para fazer parte da equipe.',
      ],
      destaque: { rotulo: 'Escritório', texto: escritorio },
      depois: [
        administra
          ? 'O convite é para administrar a página do escritório: editar as informações da sociedade e convidar outros advogados, além de cuidar do seu próprio perfil.'
          : 'Com o convite aceito, você aparece na página do escritório e continua cuidando só do seu próprio perfil.',
        // O mesmo texto para quem tem conta e para quem não tem: o e-mail não
        // pode dizer a ninguém quem está cadastrado aqui.
        'Se você já tem conta com este e-mail, o convite está no seu painel. Se ainda não tem, crie a conta com este mesmo e-mail e ele aparece lá. Aceitar ou recusar é decisão sua.',
        'O advoc.me não confere escritórios nem inscrições na OAB. Se você não reconhece este escritório, ignore esta mensagem.',
      ],
      botao: { rotulo: 'Ver o convite', caminho: '/painel' },
      links: [{ rotulo: 'Ainda não tenho conta', caminho: '/criar-conta?next=%2Fpainel' }],
    }
  },

  'termos-atualizados': (d) => {
    const desde = versaoPorExtenso(d.versao)
    return {
      assunto: 'Atualizamos os Termos de Uso e a Política de Privacidade',
      titulo: 'Os Termos do advoc.me mudaram',
      paragrafos: [
        `Publicamos uma nova versão dos Termos de Uso e da Política de Privacidade${desde ? `, em vigor desde ${desde}` : ''}.`,
        'O seu perfil continua como está. Para publicar ou salvar mudanças num perfil publicado, é preciso aceitar a versão nova — o pedido aparece no topo do seu painel, com o resumo do que mudou.',
      ],
      botao: { rotulo: 'Ver o que mudou', caminho: '/painel' },
      links: [{ rotulo: 'Ler os documentos completos', caminho: '/legal/termos' }],
    }
  },
}

// ---- Montagem -----------------------------------------------------------------

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function urlDe(site: string, caminho: string): string {
  // O caminho é sempre um literal deste arquivo — a conferência é a rede de
  // segurança para o dia em que alguém escrever um modelo novo com pressa.
  if (!caminho.startsWith('/') || caminho.startsWith('//')) throw new Error(`caminho inválido: ${caminho}`)
  return `${site}${caminho}`
}

const POR_QUE: Record<Motivo, { porque: string; canal: string }> = {
  conta: {
    porque: 'Você recebeu esta mensagem porque ela trata da sua conta no advoc.me.',
    canal: 'Esta caixa não recebe respostas — para falar com a gente, use o Suporte dentro da sua conta.',
  },
  denuncia: {
    porque: 'Você recebeu esta mensagem porque este endereço foi informado numa denúncia feita no advoc.me.',
    canal: 'Esta caixa não recebe respostas.',
  },
  convite: {
    porque: 'Você recebeu esta mensagem porque um escritório informou este endereço ao convidar um advogado no advoc.me.',
    canal: 'Esta caixa não recebe respostas.',
  },
}

function rodape(corpo: Corpo): string {
  const { porque, canal } = POR_QUE[corpo.motivo ?? 'conta']
  return `${porque} ${canal} O advoc.me é operado por ${OPERADOR.razaoSocial}, CNPJ ${OPERADOR.cnpj}.`
}

const FONTE = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const SERIFA = "Georgia,'Times New Roman',serif"

function paragrafoHtml(p: string, cor = '#443b32', tamanho = 15): string {
  return `<tr><td style="padding:12px 28px 0;font-family:${FONTE};font-size:${tamanho}px;line-height:1.6;color:${cor};">${esc(p)}</td></tr>`
}

export function renderizar(modelo: string, dados: Dados, ctx: { site: string }): Mensagem {
  if (!modeloValido(modelo)) throw new Error(`modelo desconhecido: ${modelo}`)
  const c = CORPOS[modelo](dados ?? {})
  const site = ctx.site.replace(/\/+$/, '')

  // Texto puro — quem lê e-mail sem HTML (e os filtros de spam, que comparam as
  // duas versões) recebe a mesma mensagem, na mesma ordem.
  const linhas: string[] = [c.titulo, '', ...c.paragrafos.flatMap((p) => [p, ''])]
  if (c.destaque) linhas.push(`${c.destaque.rotulo}:`, c.destaque.texto, '')
  if (c.botao) linhas.push(`${c.botao.rotulo}: ${urlDe(site, c.botao.caminho)}`, '')
  for (const p of c.depois ?? []) linhas.push(p, '')
  for (const l of c.links ?? []) linhas.push(`${l.rotulo}: ${urlDe(site, l.caminho)}`, '')
  linhas.push('—', rodape(c))
  const textoPuro = linhas.join('\n')

  const blocos: string[] = []
  blocos.push(
    `<tr><td style="padding:24px 28px 0;font-family:${SERIFA};font-size:17px;font-weight:600;color:#6b2131;">advoc.me</td></tr>`,
    `<tr><td style="padding:14px 28px 0;"><h1 style="margin:0;font-family:${SERIFA};font-size:22px;line-height:1.3;font-weight:600;color:#211c17;">${esc(c.titulo)}</h1></td></tr>`,
  )
  for (const p of c.paragrafos) blocos.push(paragrafoHtml(p))
  if (c.destaque) {
    const conteudo = esc(c.destaque.texto).replace(/\n/g, '<br>')
    blocos.push(
      `<tr><td style="padding:16px 28px 0;"><div style="border-left:3px solid #b08d57;background:#f5f0e6;padding:12px 16px;font-family:${FONTE};font-size:14px;line-height:1.55;color:#211c17;">` +
        `<div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#835f2e;margin-bottom:4px;">${esc(c.destaque.rotulo)}</div>${conteudo}</div></td></tr>`,
    )
  }
  if (c.botao) {
    const url = esc(urlDe(site, c.botao.caminho))
    blocos.push(
      `<tr><td style="padding:22px 28px 0;"><a href="${url}" style="display:inline-block;background:#6b2131;color:#faf6ec;text-decoration:none;font-family:${FONTE};font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">${esc(c.botao.rotulo)}</a></td></tr>`,
      `<tr><td style="padding:10px 28px 0;font-family:${FONTE};font-size:12px;line-height:1.5;color:#6b6155;">Se o botão não abrir, copie este endereço no navegador:<br><span style="word-break:break-all;color:#443b32;">${url}</span></td></tr>`,
    )
  }
  for (const p of c.depois ?? []) blocos.push(paragrafoHtml(p, '#443b32', 14))
  for (const l of c.links ?? []) {
    blocos.push(
      `<tr><td style="padding:12px 28px 0;font-family:${FONTE};font-size:14px;"><a href="${esc(urlDe(site, l.caminho))}" style="color:#6b2131;">${esc(l.rotulo)}</a></td></tr>`,
    )
  }
  blocos.push(
    `<tr><td style="padding:24px 28px 26px;"><div style="border-top:1px solid #e3d9c6;padding-top:14px;font-family:${FONTE};font-size:12px;line-height:1.55;color:#6b6155;">${esc(rodape(c))}</div></td></tr>`,
  )

  const html =
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="color-scheme" content="light"><title>${esc(c.assunto)}</title></head>` +
    '<body style="margin:0;padding:0;background:#ebe3d3;">' +
    // Pré-cabeçalho: a linha cinza que o aplicativo de e-mail mostra ao lado do assunto.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.paragrafos[0] ?? '')}</div>` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ebe3d3;padding:24px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#faf6ec;border:1px solid #ddd2bf;border-radius:14px;">' +
    blocos.join('') +
    '</table></td></tr></table></body></html>'

  return { assunto: c.assunto, texto: textoPuro, html }
}
