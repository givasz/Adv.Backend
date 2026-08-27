// A escada de sanções — fonte única do que cada medida faz.
//
// Fundamento e pesquisa em docs/politica-de-sancoes.md. O resumo do porquê deste
// arquivo existir: até aqui o painel tinha quatro botões soltos, sem prazo, sem
// distinção de fundamento e sem efeito sobre a cobrança. Isso é o roteiro de um
// processo — de um lado o advogado com plano pago cujo perfil sumiu e continuou
// sendo cobrado, do outro o ofendido que notificou e não foi atendido.
//
// Três coisas moram aqui, e nenhuma pode ficar espalhada:
//
//   1. **O regime** — de onde vem o direito de agir (A, B ou C). É ele que
//      decide se cabe contraditório antes ou depois.
//   2. **O degrau** — o que a medida faz, por quanto tempo, e o que acontece com
//      a cobrança.
//   3. **A identificação do denunciante** — quais motivos não aceitam denúncia
//      anônima.

// ---------------------------------------------------------------------------
// Regimes
// ---------------------------------------------------------------------------

/**
 * De onde vem o direito de agir. A classificação não é burocracia: ela decide se
 * a medida pode ser aplicada antes do contraditório, e se a plataforma tem
 * DEVER ou apenas PODER de remover.
 */
export const REGIMES = {
  /**
   * Ilícito grave (Temas 987/533 do STF, 26/06/2025): atos antidemocráticos,
   * terrorismo, pedofilia, incitação à violência, crimes contra a saúde pública.
   * A plataforma remove ao ser notificada, **sem** ordem judicial — ficar parada
   * gera responsabilidade própria. Avisar antes de remover seria dar tempo de
   * espalhar, então o aviso vai junto ou logo depois.
   */
  A: {
    id: 'A',
    label: 'Ilícito grave',
    descricao: 'Dever de remover mediante notificação, sem ordem judicial.',
    agirAntesDoContraditorio: true,
  },
  /**
   * Crime contra a honra. O art. 19 do Marco Civil continua de pé aqui: a
   * plataforma só RESPONDE se descumprir ordem judicial. Pode remover por
   * conta própria quando o texto também viola os Termos ou o Provimento — e é
   * quase sempre o caso. Quando o único fundamento seria a ofensa em si, a
   * plataforma não é juíza disso: informa o caminho judicial e registra.
   */
  B: {
    id: 'B',
    label: 'Honra',
    descricao: 'Sem ordem judicial, só age se também violar os Termos ou o Provimento.',
    agirAntesDoContraditorio: false,
  },
  /**
   * Infração de norma profissional (Prov. 205/2021, CED) ou dos Termos. O
   * fundamento é contratual. Não é ilícito penal, e a plataforma não julga
   * conduta profissional — isso é da OAB. Ela decide só sobre a presença do
   * conteúdo aqui dentro.
   */
  C: {
    id: 'C',
    label: 'Norma da advocacia / Termos',
    descricao: 'Fundamento contratual. A plataforma decide sobre o conteúdo, não sobre a conduta.',
    agirAntesDoContraditorio: false,
  },
} as const

export type RegimeId = keyof typeof REGIMES

export function isRegime(v: unknown): v is RegimeId {
  return v === 'A' || v === 'B' || v === 'C'
}

// ---------------------------------------------------------------------------
// Motivos de denúncia → regime
// ---------------------------------------------------------------------------

/**
 * A que regime cada motivo pertence. `other` cai em C por padrão: o admin
 * reclassifica se o relato descrever algo do regime A.
 */
export const REGIME_DO_MOTIVO: Record<string, RegimeId> = {
  oab_invalid: 'C', // titularidade — infração dos Termos (declaração falsa)
  result_promise: 'C',
  pricing: 'C',
  self_aggrandizement: 'C',
  solicitation: 'C',
  client_exposure: 'C',
  impersonation: 'C', // titularidade
  offensive: 'B', // pode ser honra; o admin reclassifica para A se for ilícito grave
  other: 'C',
}

/**
 * Motivos que NÃO aceitam denúncia anônima.
 *
 * Ninguém tem o próprio nome retirado do ar por reclamação de quem não se
 * identifica: são as denúncias sobre TITULARIDADE — dizer que a inscrição é
 * falsa ou que o perfil se passa por outra pessoa é uma acusação sobre quem a
 * pessoa é, e o acusador precisa ter rosto.
 *
 * Nos demais motivos o anonimato continua valendo, e de propósito: quem denuncia
 * captação irregular de um colega não deve precisar se expor numa profissão
 * pequena e competitiva.
 */
export const MOTIVOS_QUE_EXIGEM_IDENTIFICACAO = ['oab_invalid', 'impersonation'] as const

export function exigeIdentificacao(motivo: string): boolean {
  return (MOTIVOS_QUE_EXIGEM_IDENTIFICACAO as readonly string[]).includes(motivo)
}

// ---------------------------------------------------------------------------
// A escada
// ---------------------------------------------------------------------------

export interface Degrau {
  id: string
  grau: number
  label: string
  /** O que a medida alcança. */
  alvo: 'perfil' | 'conta'
  /** Quantos dias a medida vale por padrão. 0 = definitiva. */
  prazoPadraoDias: number
  /** A cobrança do plano é suspensa enquanto durar? */
  suspendeCobranca: boolean
  /** Dias que o advogado tem para contestar. */
  contestacaoDias: number
  /** Precisa de um segundo administrador? */
  duasMaos: boolean
  /** Uma linha para a tela. */
  quando: string
}

/**
 * Sete degraus. A regra geral é subir um por vez; o salto exige fundamento
 * escrito no registro — e o painel mostra o histórico do perfil antes de decidir
 * justamente para que reincidência seja visível.
 */
export const ESCADA: Degrau[] = [
  {
    id: 'warn',
    grau: 1,
    label: 'Aviso',
    alvo: 'perfil',
    prazoPadraoDias: 30,
    suspendeCobranca: false,
    contestacaoDias: 15,
    duasMaos: false,
    quando: 'Primeira infração de baixa gravidade. O perfil segue no ar.',
  },
  {
    id: 'partial',
    grau: 2,
    label: 'Ocultação parcial',
    alvo: 'perfil',
    prazoPadraoDias: 30,
    suspendeCobranca: false,
    contestacaoDias: 15,
    duasMaos: false,
    quando: 'Violação localizada — uma área, a bio, uma pergunta.',
  },
  {
    id: 'restrict',
    grau: 3,
    label: 'Restrição do perfil',
    alvo: 'perfil',
    prazoPadraoDias: 30,
    suspendeCobranca: true,
    contestacaoDias: 15,
    duasMaos: false,
    quando: 'Violação grave, ou reincidência depois de um aviso.',
  },
  {
    id: 'suspend',
    grau: 4,
    label: 'Suspensão da conta',
    alvo: 'conta',
    prazoPadraoDias: 30,
    suspendeCobranca: true,
    contestacaoDias: 15,
    duasMaos: false,
    quando: 'Fraude de identidade, burla reiterada, uso para fim ilícito.',
  },
  {
    id: 'close',
    grau: 5,
    label: 'Encerramento da conta',
    alvo: 'conta',
    prazoPadraoDias: 0,
    suspendeCobranca: true,
    contestacaoDias: 30,
    duasMaos: true,
    quando: 'Fraude confirmada, reincidência após suspensão, ordem judicial.',
  },
]

export function degrau(id: string): Degrau | undefined {
  return ESCADA.find((d) => d.id === id)
}

/** Teto do prazo que o admin pode escolher. Um ano é sanção, não esquecimento. */
const PRAZO_MAX_DIAS = 365

/**
 * Quando a medida vence. Prazo que vence sozinho é o que separa sanção de
 * punição perpétua — uma restrição esquecida na fila é uma conta morta que
 * ninguém decidiu matar.
 *
 * `dias = 0` (ou o degrau definitivo) devolve null: não vence.
 */
export function venceEm(id: string, dias?: unknown, agora = Date.now()): Date | null {
  const d = degrau(id)
  if (!d) return null

  // O tipo é conferido ANTES do Number(), e não depois. `Number(null)`,
  // `Number('')` e `Number([])` valem 0 — e como zero significa "não vence",
  // qualquer um deles produzia uma medida PERPÉTUA a partir de um campo
  // malformado. É o contrário exato do que esta função existe para garantir.
  //
  // A string vazia é o caso que mais importa: é o que um campo de formulário
  // em branco manda. Ela precisa significar "não escolhi", nunca "para sempre".
  const bruto =
    typeof dias === 'number'
      ? dias
      : typeof dias === 'string' && dias.trim() !== ''
        ? Number(dias)
        : NaN
  const usar = Number.isFinite(bruto) && bruto >= 0 ? Math.floor(bruto) : d.prazoPadraoDias

  if (usar <= 0) return null
  return new Date(agora + Math.min(usar, PRAZO_MAX_DIAS) * 24 * 60 * 60 * 1000)
}

/**
 * A medida ainda vale?
 *
 * Conferida na LEITURA, e não por uma varredura agendada — o mesmo desenho do
 * vencimento de sessão. Sem cron para esquecer de rodar, e sem uma medida
 * vencida continuar de pé porque o servidor reiniciou na hora errada.
 */
export function medidaVigente(
  status: string | null | undefined,
  ate: Date | null | undefined,
  agora = Date.now(),
): boolean {
  if (!status || status === 'active') return false
  if (!ate) return true // medidas antigas, sem prazo
  return ate.getTime() > agora
}
