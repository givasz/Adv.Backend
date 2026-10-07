// AS REGRAS DO PROGRAMA ADVOCME PARCEIROS — texto e números, num lugar só.
//
// ⚠️ REVISÃO JURÍDICA PENDENTE. Estes textos foram escritos a partir do
// Provimento 205/2021, do Código de Ética e Disciplina da OAB (Res. 02/2015) e da
// Consulta CFOAB 49.0000.2025.001346-3/OEP, mas NÃO são parecer. Antes de abrir o
// programa a mais gente, um advogado precisa ler e aprovar a lista abaixo.
//
// O LIMITE QUE NÃO SE NEGOCIA: o programa recompensa a indicação do SOFTWARE a
// outro profissional da advocacia, e nada mais. Não há recompensa ligada a
// cliente, causa, consulta, contato, visita de perfil, triagem ou contratação de
// serviço advocatício — e não pode passar a haver. É isso que separa o programa
// de captação de clientela (CED, art. 7º) e de mercantilização da profissão.
//
// Mudou o texto? Troque a versão. O aceite gravado aponta para uma versão
// concreta — sem isso não se sabe o que foi aceito. Os Termos gerais da
// plataforma (src/legal/termos.ts) NÃO mudam por causa deste arquivo.

/** Data da revisão vigente das regras do programa. */
export const PARTNER_TERMS_VERSION = '2026-10-07'

/** Enquanto for `true`, a tela e o console avisam que o texto aguarda revisão jurídica. */
export const REVISAO_JURIDICA_PENDENTE = true

/** Dias de Max concedidos uma única vez, no aceite. */
export const BENEFICIO_INICIAL_DIAS = 45
/** Dias de Max por conta indicada que pagou Pro ou Max (os dois valem o mesmo). */
export const RECOMPENSA_DIAS = 30
/** Dias completos entre a confirmação do pagamento e a confirmação da recompensa. */
export const VALIDACAO_DIAS = 7
/** Janela entre o clique no link e o cadastro. Depois de criada a conta, o vínculo não expira. */
export const ATRIBUICAO_DIAS = 30
/** Com quantos dias de antecedência o parceiro é avisado de que o benefício vai acabar. */
export const AVISO_DE_FIM_DIAS = 7

export const NOME_DO_PROGRAMA = 'Programa Advocme Parceiros'
export const CHAMADA_DO_PROGRAMA = 'Indique o Advocme a outros profissionais e amplie seu acesso ao MAX.'

/** Aviso obrigatório — aparece no painel do parceiro e no aceite. */
export const AVISO_OBRIGATORIO =
  'O Programa Advocme Parceiros destina-se exclusivamente à indicação da plataforma Advocme a outros ' +
  'profissionais da advocacia. Não há recompensa por indicação de clientes, causas, consultas, contatos ' +
  'ou contratação de serviços advocatícios.'

/** As regras que o advogado aceita. A ordem é a da tela. */
export const REGRAS_DO_PROGRAMA: readonly string[] = [
  'O programa existe exclusivamente para a indicação do software Advocme a outros profissionais da advocacia.',
  'A elegibilidade para participar é definida pelo Advocme, por convite.',
  `No aceite, você recebe ${BENEFICIO_INICIAL_DIAS} dias de acesso ao MAX, uma única vez.`,
  'O benefício é acesso adicional ao MAX. Não é dinheiro, não é convertível em dinheiro e não pode ser transferido.',
  `Cada nova conta indicada pode gerar no máximo uma recompensa de ${RECOMPENSA_DIAS} dias, quando contrata PRO ou MAX.`,
  'Cadastro gratuito não gera benefício, e renovações mensais não geram nova recompensa.',
  `O pagamento da nova conta precisa ser confirmado e passa por uma validação de ${VALIDACAO_DIAS} dias antes de virar benefício.`,
  'Estorno e contestação do pagamento (chargeback) revogam a recompensa correspondente.',
  'Fraude, autoindicação ou uso abusivo podem levar à suspensão ou ao encerramento da participação.',
  'É proibido divulgar o link por spam, mensagens em massa ou de forma indiscriminada.',
  'A participação não cria relação de emprego, sociedade, representação comercial ou mandato com o Advocme.',
  'A participação não autoriza a captação de clientes jurídicos nem qualquer publicidade vedada pelas normas da OAB.',
  'Tratamos o mínimo de dados: você vê apenas a situação de cada indicação, nunca nome, e-mail ou dados de pagamento de quem se cadastrou.',
  'As regras podem mudar mediante comunicação prévia; a versão aceita fica registrada com data.',
  'O benefício não gera cobrança automática. Ao término, sua conta retorna ao plano financeiro que estiver vigente.',
]

/** Para quem já paga o PRO: o benefício é acesso adicional, a assinatura continua. */
export const AVISO_PRO =
  'Seu plano PRO continua sendo cobrado normalmente. O programa amplia temporariamente seu acesso para o MAX.'

/** O fim da cortesia, dito antes. */
export const AVISO_FIM_SEM_COBRANCA =
  'A cortesia não gera cobrança automática. Ao término, sua conta retorna ao plano financeiro que estiver vigente.'

/** Quem já paga o MAX com renovação ativa não ativa a cortesia — e precisa saber por quê. */
export const AVISO_MAX_ATIVO =
  'Sua assinatura MAX está com renovação ativa. Para ativar a cortesia, cancele primeiro a renovação em ' +
  'Minha assinatura: você continua usando o período já pago, e os dias do programa começam a contar ' +
  'quando ele terminar.'

/** MAX fornecido pelo escritório, sem término conhecido: não há o que somar. */
export const AVISO_MAX_ESCRITORIO =
  'Seu acesso ao MAX hoje vem do escritório, sem data de término. A cortesia do programa só pode ser ' +
  'ativada quando esse acesso deixar de valer.'
