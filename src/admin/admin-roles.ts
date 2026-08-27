// O que cada papel do painel pode fazer — fonte única.
//
// Existe pelo mesmo motivo de lib/planFeatures.ts no front: enquanto a resposta a
// "quem pode restringir um perfil?" estava espalhada pelos controllers, ela era
// "quem tiver a senha do painel" — uma senha só, para todo mundo. Aqui a pergunta
// tem um lugar, e uma rota nova que invente uma permissão fora desta tabela é
// barrada pelo teste (ver admin-roles.spec.ts).
//
// A regra de corte entre os papéis é simples e deliberada: **decidir é diferente
// de consultar**. Quem entra para responder um chamado de suporte precisa ver o
// perfil de quem reclamou — não precisa poder tirá-lo do ar.
//
// Os valores são os mesmos do enum AdminRole do schema. O tipo é escrito aqui e
// NÃO importado de `@prisma/client` porque o schema de desenvolvimento (SQLite)
// não tem enums — o cliente gerado localmente não os exporta, e importar de lá
// quebra o build só no ambiente local, que é justamente onde se testa.

export const ADMIN_ROLES = ['owner', 'moderator', 'support', 'readonly'] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v)
}

/**
 * Permissão → papéis que a têm.
 *
 * Ordem de leitura: as de consulta primeiro, as que decidem depois. Ao criar uma
 * permissão nova, pergunte se ela DECIDE algo sobre alguém; se decide, ela não
 * pertence a `support` nem a `readonly`.
 */
export const PERMISSOES = {
  // ---- Consulta ----
  /** Abrir o painel. Todo papel ativo tem. */
  'painel:abrir': ['owner', 'moderator', 'support', 'readonly'],
  /** Ver a fila de denúncias e o detalhe de um perfil denunciado. */
  'moderacao:ler': ['owner', 'moderator', 'support', 'readonly'],
  /** Buscar advogados e ver a ficha deles. */
  'contas:ler': ['owner', 'moderator', 'support', 'readonly'],
  /** Ver chamados de suporte. */
  'suporte:ler': ['owner', 'moderator', 'support', 'readonly'],
  /** Ler o histórico de ações do painel. */
  'auditoria:ler': ['owner', 'moderator', 'readonly'],

  // ---- Decisão ----
  /** Avisar, censurar seções, restringir ou liberar um perfil. */
  'moderacao:decidir': ['owner', 'moderator'],
  /** Mudar a situação de um chamado e responder ao advogado. */
  'suporte:responder': ['owner', 'moderator', 'support'],
  /** Suspender, reativar e encerrar a CONTA de um advogado (degraus 4 e 5 da
   *  escada — ver sancoes.ts e docs/politica-de-sancoes.md). Fica com quem já
   *  decide moderação: quem atende suporte não tira ninguém da plataforma. */
  'contas:sancionar': ['owner', 'moderator'],
  /** Criar, mudar o papel, desativar administradores e derrubar sessões deles. */
  'admins:gerir': ['owner'],
} as const satisfies Record<string, readonly AdminRole[]>

export type Permissao = keyof typeof PERMISSOES

export const PERMISSOES_LISTA = Object.keys(PERMISSOES) as Permissao[]

/** Este papel tem esta permissão? Falha fechada: papel desconhecido não tem nada. */
export function pode(papel: string | undefined, permissao: Permissao): boolean {
  const papeis = PERMISSOES[permissao] as readonly string[] | undefined
  if (!papeis) return false
  return !!papel && papeis.includes(papel)
}

/** Tudo o que este papel abre — é o que o painel usa para montar as abas. */
export function permissoesDe(papel: string | undefined): Permissao[] {
  return PERMISSOES_LISTA.filter((p) => pode(papel, p))
}

/**
 * As permissões que DECIDEM alguma coisa sobre alguém.
 *
 * A lista é escrita à mão, e não deduzida do nome da permissão, porque é ela que
 * decide duas coisas sérias: o que o segundo fator pendente trava, e o que exige
 * motivo escrito. Deduzir por sufixo (":ler" é consulta, o resto decide) daria
 * certo hoje e falharia calado no dia em que alguém criasse "moderacao:exportar".
 */
export const PERMISSOES_DE_DECISAO: readonly Permissao[] = [
  'moderacao:decidir',
  'suporte:responder',
  'contas:sancionar',
  'admins:gerir',
]

export function decide(permissao: Permissao): boolean {
  return PERMISSOES_DE_DECISAO.includes(permissao)
}

/**
 * Papéis que MEXEM na plataforma e, por isso, exigem segundo fator.
 *
 * `support` fica de fora de propósito: ele responde chamado e consulta, e exigir
 * TOTP de quem só atende empurraria a equipe a compartilhar um login — que é
 * exatamente o problema que esta fase veio resolver.
 */
export const PAPEIS_COM_SEGUNDO_FATOR: readonly AdminRole[] = ['owner', 'moderator']

export function exigeSegundoFator(papel: string | undefined): boolean {
  return !!papel && (PAPEIS_COM_SEGUNDO_FATOR as readonly string[]).includes(papel)
}

/** Nome do papel para a tela. */
export const ROLE_LABEL: Record<AdminRole, string> = {
  owner: 'Responsável',
  moderator: 'Moderação',
  support: 'Suporte',
  readonly: 'Só leitura',
}

/** Uma linha explicando o papel, para quem cria um administrador novo. */
export const ROLE_DESCRICAO: Record<AdminRole, string> = {
  owner: 'Tudo, inclusive criar e desativar administradores.',
  moderator: 'Decide moderação e lê o histórico. Não mexe em administradores.',
  support: 'Responde chamados e consulta perfis. Não tira nada do ar.',
  readonly: 'Só consulta. Nenhuma decisão.',
}
