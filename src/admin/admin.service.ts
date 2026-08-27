// O painel de administração: quem entra, o que pode, e o registro do que fez.
//
// Três coisas moram aqui, e moram juntas de propósito:
//
//   1. **Identidade.** Antes o painel tinha UM usuário e UMA senha, no .env.
//      Não havia papéis (quem respondia um chamado podia tirar qualquer perfil
//      do ar), não havia autoria (nenhuma decisão dizia quem a tomou) e não
//      havia como revogar acesso sem trocar a senha de todo mundo.
//   2. **Sessão.** Saiu do Map em memória para o banco: reiniciar a API não
//      desloga mais ninguém, e derrubar o aparelho de alguém passou a existir.
//   3. **Registro.** Toda escrita do painel grava uma linha em AdminAction —
//      quem, quando, sobre quem, e por quê. Sem isso o advogado não tem como
//      contestar e o administrador não tem como se defender.
//
// A porta de emergência: enquanto a tabela AdminUser estiver VAZIA, a credencial
// do .env ainda entra, como `owner`. É assim que o primeiro administrador nasce
// (pelo painel ou por `npm run admin:create`). Criado o primeiro, essa porta
// fecha sozinha — sem precisar de deploy, sem variável para lembrar de tirar.

import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { assertCsrf, csrfTokenFor } from '../auth/csrf'
import { authDe, type RequisicaoComAuth } from '../auth/session-context'
import {
  burnPasswordTime,
  credencialConfere,
  hashPassword,
  lerCookie,
  montarCookie,
  novaCredencial,
  verifyPassword,
} from '../auth/user-auth'
import { fingerprint, logSecurityEvent } from '../security/audit-log'
import { IS_PROD } from '../security/config'
import {
  ADMIN_COOKIE,
  ADMIN_COOKIE_PATH,
  ADMIN_CSRF_COOKIE,
  adminUsername,
  duracaoSessaoAdmin,
  tokenEstaticoConfere,
  verifyCredentials,
} from './admin-auth'
import {
  decide,
  exigeSegundoFator,
  isAdminRole,
  permissoesDe,
  pode,
  type AdminRole,
  type Permissao,
} from './admin-roles'
import { novoSegredoTotp, otpauthUrl, segredoLegivel, totpConfere } from './totp'
import { faixaTrilha, trilha } from './paginacao'

/** Quem está usando o painel nesta requisição. */
export interface AdminAtual {
  /** Nulo quando a ação veio da credencial de emergência do .env. */
  id: string | null
  label: string
  role: AdminRole
  /** Nulo quando entrou pelo token estático legado (script, só fora de produção). */
  sessionId: string | null
  /** O papel exige segundo fator e ele ainda não foi configurado. */
  totpPendente: boolean
  /** Está usando a credencial do .env porque ainda não há administrador criado. */
  emergencia: boolean
}

export interface SessaoAdminAberta {
  expiresAt: number
  csrfToken: string
}

const SENHA_MIN = 12
const MOTIVO_MAX = 1000

/** Sessão da credencial de emergência: fica em memória porque não há linha
 *  AdminUser para apontar. É a única sessão que um restart ainda derruba — e,
 *  sendo a porta de emergência, isso é aceitável e até saudável. */
interface SessaoEmergencia {
  tokenHash: string
  expiresAt: number
}

@Injectable()
export class AdminService {
  private readonly emergencia = new Map<string, SessaoEmergencia>()
  /** Memória de que a tabela deixou de estar vazia. Nunca volta para false:
   *  administrador não é apagado, é desativado — e a última conta ativa com
   *  papel `owner` é protegida contra desativação (ver atualizarAdmin). */
  private jaTemAdmin = false

  constructor(private readonly prisma: PrismaService) {}

  // ---- Existe algum administrador? -----------------------------------------

  /**
   * A porta de emergência do .env ainda está aberta?
   *
   * Falha FECHADA ao contrário do usual, e de propósito: se o banco estiver fora,
   * respondemos "já existe administrador" e a credencial do .env NÃO entra. Um
   * banco intermitente não pode virar o caminho mais fácil para o painel.
   */
  private async temAdmin(): Promise<boolean> {
    if (this.jaTemAdmin) return true
    try {
      const n = await this.prisma.adminUser.count()
      if (n > 0) this.jaTemAdmin = true
      return n > 0
    } catch {
      return true
    }
  }

  // ---- Entrar ---------------------------------------------------------------

  /**
   * Confere as credenciais e abre a sessão do painel.
   *
   * O tempo gasto é o mesmo com usuário existente e inexistente: sem isso,
   * "falhou rápido" significa "esta conta não existe" e a lista de quem
   * administra a plataforma vira consulta pública.
   */
  async entrar(
    req: RequisicaoComAuth,
    corpo: { username?: string; password?: string; totp?: string },
    ip?: string,
  ): Promise<SessaoAdminAberta & { name: string; role: AdminRole; totpPendente: boolean }> {
    const usuario = (corpo?.username ?? '').trim().toLowerCase()
    const senha = corpo?.password ?? ''
    const impressao = fingerprint(ip)

    const conta = usuario
      ? await this.prisma.adminUser
          .findUnique({ where: { email: usuario } })
          .catch(() => null)
      : null

    // Porta de emergência: só enquanto NÃO existe administrador nenhum.
    if (!conta) {
      if (!(await this.temAdmin()) && verifyCredentials(corpo?.username, senha)) {
        const label = adminUsername()
        const aberta = this.abrirSessaoEmergencia(req)
        logSecurityEvent({ event: 'admin_login_ok', ip: impressao, resource: 'emergencia', result: 'ok' })
        await this.registrar(
          { id: null, label, role: 'owner', sessionId: null, totpPendente: false, emergencia: true },
          { action: 'sessao.abrir', targetType: 'admin', reason: 'credencial de emergência (.env)', ip },
        )
        return { ...aberta, name: label, role: 'owner', totpPendente: false }
      }
      // Gasta o tempo de uma verificação real antes de recusar.
      burnPasswordTime(senha)
      logSecurityEvent({ event: 'admin_login_fail', ip: impressao, result: 'negado' })
      throw new UnauthorizedException('Usuário ou senha inválidos')
    }

    const senhaOk = verifyPassword(senha, conta.passwordHash)
    // Conta desativada responde igual a senha errada: quem foi desligado não
    // descobre por aqui que a conta dele ainda existe.
    if (!senhaOk || !conta.active) {
      logSecurityEvent({
        event: 'admin_login_fail',
        ip: impressao,
        subject: fingerprint(conta.email),
        result: 'negado',
      })
      throw new UnauthorizedException('Usuário ou senha inválidos')
    }

    if (conta.totpEnabled && !totpConfere(conta.totpSecret, corpo?.totp)) {
      logSecurityEvent({
        event: 'admin_login_fail',
        ip: impressao,
        subject: fingerprint(conta.email),
        resource: 'totp',
        result: 'negado',
      })
      // Mensagem diferente de propósito: quem já passou pela senha tem direito de
      // saber que o que faltou foi o código, senão fica tentando a senha de novo.
      throw new UnauthorizedException('Código de verificação inválido.')
    }

    const papel = (isAdminRole(conta.role) ? conta.role : 'readonly') as AdminRole
    const aberta = await this.abrirSessao(conta.id, req, ip)
    await this.prisma.adminUser
      .update({ where: { id: conta.id }, data: { lastLoginAt: new Date() } })
      .catch(() => undefined)

    const totpPendente = exigeSegundoFator(papel) && !conta.totpEnabled
    const atual: AdminAtual = {
      id: conta.id,
      label: conta.name || conta.email,
      role: papel,
      sessionId: null,
      totpPendente,
      emergencia: false,
    }
    logSecurityEvent({
      event: 'admin_login_ok',
      ip: impressao,
      subject: fingerprint(conta.email),
      result: 'ok',
    })
    await this.registrar(atual, { action: 'sessao.abrir', targetType: 'admin', targetId: conta.id, ip })

    return { ...aberta, name: atual.label, role: papel, totpPendente }
  }

  private cookies(req: RequisicaoComAuth, id: string, secret: string, idleMs: number): SessaoAdminAberta {
    const auth = authDe(req)
    const csrfToken = csrfTokenFor(id)
    const comum = { maxAgeMs: idleMs, path: ADMIN_COOKIE_PATH }
    auth.setCookie(ADMIN_COOKIE, montarCookie(id, secret), { httpOnly: true, ...comum })
    auth.setCookie(ADMIN_CSRF_COOKIE, csrfToken, { httpOnly: false, ...comum })
    return { expiresAt: Date.now() + idleMs, csrfToken }
  }

  private async abrirSessao(adminId: string, req: RequisicaoComAuth, ip?: string): Promise<SessaoAdminAberta> {
    const { idleMs, absolutoMs } = duracaoSessaoAdmin()
    // Higiene barata: as vencidas deste administrador saem no login seguinte.
    await this.prisma.adminSession
      .deleteMany({ where: { adminId, expiresAt: { lt: new Date() } } })
      .catch(() => undefined)

    const id = randomBytes(16).toString('hex')
    const { secret, hash } = novaCredencial()
    const agora = Date.now()
    await this.prisma.adminSession.create({
      data: {
        id,
        adminId,
        tokenHash: hash,
        expiresAt: new Date(agora + idleMs),
        absoluteExpiresAt: new Date(agora + absolutoMs),
        ipFingerprint: fingerprint(ip) ?? '',
      },
    })
    return this.cookies(req, id, secret, idleMs)
  }

  private abrirSessaoEmergencia(req: RequisicaoComAuth): SessaoAdminAberta {
    const agora = Date.now()
    for (const [id, s] of this.emergencia) if (s.expiresAt <= agora) this.emergencia.delete(id)
    const { idleMs } = duracaoSessaoAdmin()
    const id = randomBytes(16).toString('hex')
    const { secret, hash } = novaCredencial()
    this.emergencia.set(id, { tokenHash: hash, expiresAt: agora + idleMs })
    return this.cookies(req, id, secret, idleMs)
  }

  // ---- Quem está falando ----------------------------------------------------

  /**
   * O administrador desta requisição, ou null. Falha fechada: cookie estranho,
   * sessão apagada, conta desativada e banco fora do ar dão todos "ninguém".
   */
  async atual(req?: RequisicaoComAuth): Promise<AdminAtual | null> {
    const auth = authDe(req)
    const valor = lerCookie(auth.cookie(ADMIN_COOKIE))
    if (!valor) return null

    // 1. Sessão de emergência (em memória).
    const emergencia = this.emergencia.get(valor.sessionId)
    if (emergencia) {
      if (emergencia.expiresAt <= Date.now()) {
        this.emergencia.delete(valor.sessionId)
        return null
      }
      if (!credencialConfere(valor.secret, emergencia.tokenHash)) return null
      // Criado o primeiro administrador, a porta fecha — inclusive para quem já
      // estava com ela aberta. Senão o painel continuaria sem autoria por horas.
      if (await this.temAdmin()) {
        this.emergencia.delete(valor.sessionId)
        return null
      }
      return {
        id: null,
        label: adminUsername(),
        role: 'owner',
        sessionId: valor.sessionId,
        totpPendente: false,
        emergencia: true,
      }
    }

    // 2. Sessão no banco.
    try {
      const sessao = await this.prisma.adminSession.findUnique({
        where: { id: valor.sessionId },
        include: { admin: true },
      })
      if (!sessao?.admin) return null
      if (!credencialConfere(valor.secret, sessao.tokenHash)) return null
      if (!sessao.admin.active) return null

      const agora = Date.now()
      const absoluto = sessao.absoluteExpiresAt.getTime()
      if (sessao.expiresAt.getTime() <= agora || absoluto <= agora) return null

      await this.talvezRenovar(req, sessao.id, valor.secret, sessao.expiresAt.getTime(), absoluto, agora)

      const papel = (isAdminRole(sessao.admin.role) ? sessao.admin.role : 'readonly') as AdminRole
      return {
        id: sessao.admin.id,
        label: sessao.admin.name || sessao.admin.email,
        role: papel,
        sessionId: sessao.id,
        totpPendente: exigeSegundoFator(papel) && !sessao.admin.totpEnabled,
        emergencia: false,
      }
    } catch {
      return null
    }
  }

  /**
   * Renovação deslizante — a sessão de quem está trabalhando não vence embaixo
   * dele. Só grava passada METADE do prazo, senão seria uma escrita por clique.
   */
  private async talvezRenovar(
    req: RequisicaoComAuth | undefined,
    sessionId: string,
    secret: string,
    atual: number,
    absoluto: number,
    agora: number,
  ): Promise<void> {
    const { idleMs } = duracaoSessaoAdmin()
    if (atual - agora > idleMs / 2) return
    const novo = Math.min(agora + idleMs, absoluto)
    if (novo <= atual) return
    try {
      await this.prisma.adminSession.updateMany({
        where: { id: sessionId },
        data: { expiresAt: new Date(novo) },
      })
    } catch {
      return // renovar é conforto, não requisito
    }
    // O cookie também precisa esticar, senão o navegador o descarta no prazo
    // antigo e a sessão "renovada" morreria no cliente.
    this.cookies(req ?? {}, sessionId, secret, novo - agora)
  }

  // ---- A porta ---------------------------------------------------------------

  /**
   * A porta do painel: deixa passar quem tem a permissão pedida e recusa o resto,
   * sempre com registro. Vive aqui, e não repetida em cada controller, para que
   * uma rota nova não possa esquecer metade da verificação.
   *
   * Dois caminhos, e a diferença entre eles é o que decide o CSRF:
   *
   *   • **Cookie de sessão** — o navegador o manda sozinho, então toda escrita
   *     precisa provar que partiu do painel (token no cabeçalho + Origin conhecida).
   *   • **Token estático legado** — escrito à mão por quem chama (script, curl);
   *     nenhum site consegue forjá-lo do navegador de outra pessoa. Fora de
   *     produção apenas: em produção ele deixou de valer, porque um bearer sem
   *     expiração que ainda por cima pula o CSRF é um portão lateral no painel.
   */
  async exigir(
    req: RequisicaoComAuth | undefined,
    permissao: Permissao,
    tokenLegado?: string,
  ): Promise<AdminAtual> {
    // O token de serviço entra como um administrador `readonly` e segue pelo
    // MESMO caminho do resto. Enquanto ele voltava daqui direto, pulava a
    // conferência de permissão logo abaixo — ou seja, um bearer sem expiração
    // que decidia tudo. É a exata classe de furo que esta fase veio fechar.
    const atual =
      (await this.atual(req)) ??
      (tokenEstaticoConfere(tokenLegado)
        ? ({
            id: null,
            label: 'token de serviço',
            role: 'readonly',
            sessionId: null,
            totpPendente: false,
            emergencia: false,
          } as AdminAtual)
        : null)

    if (!atual) {
      logSecurityEvent({ event: 'access_denied', resource: `admin:${permissao}`, result: 'negado' })
      throw new ForbiddenException('Acesso de administrador inválido')
    }

    if (atual.sessionId) {
      const auth = authDe(req)
      assertCsrf(
        { method: auth.method, origin: auth.origin, csrfHeader: auth.csrfHeader },
        atual.sessionId,
      )
    }

    if (!pode(atual.role, permissao)) {
      logSecurityEvent({
        event: 'access_denied',
        userId: atual.id ?? undefined,
        resource: `admin:${permissao}`,
        result: 'negado',
      })
      throw new ForbiddenException(
        'Seu papel no painel não permite esta ação. Fale com o responsável.',
      )
    }

    // Segundo fator pendente trava o que DECIDE, não o que consulta: quem entrou
    // ainda consegue trabalhar na fila e configurar o aplicativo, mas nada sai do
    // ar até o segundo fator existir.
    if (decide(permissao) && atual.totpPendente) {
      throw new ForbiddenException(
        'Configure o segundo fator (código de 6 dígitos) antes de decidir qualquer coisa.',
      )
    }

    return atual
  }

  /** Só confere que há sessão aberta — sem exigir permissão nenhuma. */
  async exigirSessao(req?: RequisicaoComAuth): Promise<AdminAtual> {
    const atual = await this.atual(req)
    if (!atual) throw new UnauthorizedException('Sessão do painel encerrada.')
    if (atual.sessionId) {
      const auth = authDe(req)
      assertCsrf(
        { method: auth.method, origin: auth.origin, csrfHeader: auth.csrfHeader },
        atual.sessionId,
      )
    }
    return atual
  }

  // ---- Sair -----------------------------------------------------------------

  /** Encerra a sessão do painel e apaga os cookies. Nunca lança. */
  async sair(req?: RequisicaoComAuth): Promise<void> {
    const auth = authDe(req)
    const valor = lerCookie(auth.cookie(ADMIN_COOKIE))
    if (valor) {
      const emergencia = this.emergencia.get(valor.sessionId)
      if (emergencia) {
        // Só encerra se a credencial confere: quem adivinhasse um id não derruba
        // a sessão alheia de graça.
        if (credencialConfere(valor.secret, emergencia.tokenHash)) {
          this.emergencia.delete(valor.sessionId)
        }
      } else {
        const sessao = await this.prisma.adminSession
          .findUnique({ where: { id: valor.sessionId }, select: { tokenHash: true } })
          .catch(() => null)
        if (sessao && credencialConfere(valor.secret, sessao.tokenHash)) {
          await this.prisma.adminSession.deleteMany({ where: { id: valor.sessionId } }).catch(() => undefined)
          logSecurityEvent({ event: 'admin_logout', result: 'ok' })
        }
      }
    }
    auth.clearCookie(ADMIN_COOKIE, { httpOnly: true, path: ADMIN_COOKIE_PATH })
    auth.clearCookie(ADMIN_CSRF_COOKIE, { httpOnly: false, path: ADMIN_COOKIE_PATH })
  }

  // ---- O registro -----------------------------------------------------------

  /**
   * Grava o que o administrador acabou de fazer.
   *
   * Nunca lança: um erro ao registrar não pode desfazer uma decisão já aplicada
   * nem devolver 500 a quem clicou. Mas também nunca é opcional — o teste
   * admin-registro.spec.ts percorre as rotas de escrita do painel e falha se
   * alguma delas não chamar esta função.
   */
  async registrar(
    quem: AdminAtual,
    dados: {
      action: string
      targetType?: string
      targetId?: string
      reason?: string
      before?: unknown
      after?: unknown
      ip?: string
    },
  ): Promise<void> {
    try {
      await this.prisma.adminAction.create({
        data: {
          adminId: quem.id,
          adminLabel: quem.label.slice(0, 120),
          adminRole: quem.role,
          action: dados.action,
          targetType: dados.targetType ?? '',
          targetId: dados.targetId ?? '',
          reason: (dados.reason ?? '').slice(0, MOTIVO_MAX),
          before: recorte(dados.before),
          after: recorte(dados.after),
          ip: fingerprint(dados.ip) ?? '',
        },
      })
    } catch {
      /* o registro não pode derrubar a ação que já aconteceu */
    }
  }

  /** Motivo escrito, exigido em toda decisão que afeta alguém. */
  exigirMotivo(texto: string | undefined, oQue = 'esta decisão'): string {
    const limpo = (texto ?? '').trim()
    if (limpo.length < 5) {
      throw new BadRequestException(
        `Escreva o motivo de ${oQue}. É o texto que a pessoa afetada vai ler.`,
      )
    }
    return limpo.slice(0, MOTIVO_MAX)
  }

  /**
   * Histórico de ações, filtrado. O mais recente primeiro.
   *
   * Paginado por CURSOR, e não por deslocamento, porque esta tabela recebe linha
   * nova no topo o tempo todo: com deslocamento, uma ação registrada entre um
   * "carregar mais" e o seguinte empurraria a lista e faria a página seguinte
   * repetir o que já estava na tela. Numa trilha de auditoria, ver a mesma
   * decisão duas vezes não é um incômodo — é uma leitura errada do que houve.
   */
  async historico(filtros: {
    admin?: string
    action?: string
    targetType?: string
    targetId?: string
    limite?: unknown
    cursor?: string
  }) {
    const take = faixaTrilha(filtros.limite)
    const linhas = await this.prisma.adminAction.findMany({
      where: {
        ...(filtros.admin ? { adminId: filtros.admin } : {}),
        ...(filtros.action ? { action: { startsWith: filtros.action } } : {}),
        ...(filtros.targetType ? { targetType: filtros.targetType } : {}),
        ...(filtros.targetId ? { targetId: filtros.targetId } : {}),
      },
      // O id desempata: duas ações no mesmo milissegundo teriam ordem instável,
      // e o cursor precisa de uma ordem total para não pular nem repetir linha.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Um a mais do que se vai mostrar: se ele vier, é porque há mais.
      take: take + 1,
      ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {}),
    })
    return trilha(linhas, take)
  }

  // ---- Gestão de administradores --------------------------------------------

  async listarAdmins() {
    const linhas = await this.prisma.adminUser.findMany({
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        totpEnabled: true,
        createdAt: true,
        lastLoginAt: true,
        _count: { select: { sessions: true } },
      },
    })
    return linhas.map(({ _count, ...a }) => ({ ...a, sessoes: _count.sessions }))
  }

  async criarAdmin(
    quem: AdminAtual,
    corpo: { email?: string; name?: string; password?: string; role?: string },
    ip?: string,
  ) {
    const email = (corpo?.email ?? '').trim().toLowerCase()
    const name = (corpo?.name ?? '').trim().slice(0, 120)
    const senha = corpo?.password ?? ''
    const role = isAdminRole(corpo?.role) ? corpo.role : 'support'

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new BadRequestException('E-mail inválido.')
    }
    if (!name) throw new BadRequestException('Informe o nome de quem vai administrar.')
    this.conferirSenha(senha, email)

    const existe = await this.prisma.adminUser.findUnique({ where: { email }, select: { id: true } })
    if (existe) throw new BadRequestException('Já existe um administrador com este e-mail.')

    const criado = await this.prisma.adminUser.create({
      data: { email, name, role, passwordHash: hashPassword(senha) },
      select: { id: true, email: true, name: true, role: true, active: true },
    })
    this.jaTemAdmin = true
    await this.registrar(quem, {
      action: 'admin.criar',
      targetType: 'admin',
      targetId: criado.id,
      reason: `papel ${role}`,
      after: { email, name, role },
      ip,
    })
    return criado
  }

  /**
   * Muda papel, nome ou situação de um administrador.
   *
   * Duas travas que existem para o painel não se trancar por fora:
   *   • ninguém muda o próprio papel nem se desativa (seria perder o acesso com
   *     um clique, e um responsável que se rebaixa sem querer não tem quem o
   *     promova de volta);
   *   • o ÚLTIMO responsável ativo não pode ser desativado nem rebaixado.
   */
  async atualizarAdmin(
    quem: AdminAtual,
    id: string,
    corpo: { name?: string; role?: string; active?: boolean; reason?: string },
    ip?: string,
  ) {
    const alvo = await this.prisma.adminUser.findUnique({ where: { id } })
    if (!alvo) throw new BadRequestException('Administrador não encontrado.')
    // Retrato do estado ANTES, tirado agora. Ler `alvo` depois do update seria
    // ler o depois: o histórico diria que nada mudou.
    const antes = { name: alvo.name, role: alvo.role, active: alvo.active }

    const mudaPapel = corpo.role !== undefined && corpo.role !== alvo.role
    const mudaAtivo = corpo.active !== undefined && corpo.active !== alvo.active

    if (quem.id === id && (mudaPapel || (mudaAtivo && corpo.active === false))) {
      throw new BadRequestException(
        'Você não pode mudar o próprio papel nem se desativar. Peça a outro responsável.',
      )
    }
    if (mudaPapel && !isAdminRole(corpo.role)) throw new BadRequestException('Papel inválido.')

    const saindoDeOwner = alvo.role === 'owner' && (mudaPapel || (mudaAtivo && corpo.active === false))
    if (saindoDeOwner) {
      const outros = await this.prisma.adminUser.count({
        where: { role: 'owner', active: true, id: { not: id } },
      })
      if (outros === 0) {
        throw new BadRequestException(
          'Este é o único responsável ativo. Promova outro antes de mudar este.',
        )
      }
    }

    const motivo = mudaPapel || mudaAtivo ? this.exigirMotivo(corpo.reason, 'esta mudança') : ''

    const atualizado = await this.prisma.adminUser.update({
      where: { id },
      data: {
        ...(corpo.name !== undefined ? { name: corpo.name.trim().slice(0, 120) } : {}),
        ...(mudaPapel ? { role: corpo.role as AdminRole } : {}),
        ...(mudaAtivo ? { active: !!corpo.active } : {}),
      },
      select: { id: true, email: true, name: true, role: true, active: true },
    })

    // Desativar sem derrubar as sessões abertas seria desativar só no papel.
    if (mudaAtivo && corpo.active === false) {
      await this.prisma.adminSession.deleteMany({ where: { adminId: id } }).catch(() => undefined)
    }

    await this.registrar(quem, {
      action: mudaAtivo ? (corpo.active ? 'admin.reativar' : 'admin.desativar') : 'admin.editar',
      targetType: 'admin',
      targetId: id,
      reason: motivo,
      before: antes,
      after: { name: atualizado.name, role: atualizado.role, active: atualizado.active },
      ip,
    })
    return atualizado
  }

  /** Derruba todas as sessões de um administrador (aparelho perdido, desligamento). */
  async derrubarSessoes(quem: AdminAtual, id: string, reason?: string, ip?: string) {
    const motivo = this.exigirMotivo(reason, 'derrubar as sessões')
    const { count } = await this.prisma.adminSession.deleteMany({ where: { adminId: id } })
    await this.registrar(quem, {
      action: 'admin.derrubar-sessoes',
      targetType: 'admin',
      targetId: id,
      reason: motivo,
      after: { sessoes: count },
      ip,
    })
    return { encerradas: count }
  }

  /** Troca da própria senha. Derruba as outras sessões — inclusive a de quem
   *  estivesse com a senha antiga. */
  async trocarPropriaSenha(quem: AdminAtual, atual: string, nova: string, ip?: string) {
    if (!quem.id) throw new BadRequestException('A credencial de emergência não tem senha para trocar aqui.')
    const conta = await this.prisma.adminUser.findUnique({ where: { id: quem.id } })
    if (!conta || !verifyPassword(atual ?? '', conta.passwordHash)) {
      throw new UnauthorizedException('Senha atual incorreta.')
    }
    this.conferirSenha(nova, conta.email)
    await this.prisma.adminUser.update({
      where: { id: quem.id },
      data: { passwordHash: hashPassword(nova) },
    })
    await this.prisma.adminSession
      .deleteMany({ where: { adminId: quem.id, id: { not: quem.sessionId ?? '' } } })
      .catch(() => undefined)
    await this.registrar(quem, {
      action: 'admin.trocar-senha',
      targetType: 'admin',
      targetId: quem.id,
      reason: 'troca de senha pelo próprio administrador',
      ip,
    })
    return { ok: true }
  }

  private conferirSenha(senha: string, email: string): void {
    const s = senha ?? ''
    if (s.length < SENHA_MIN) {
      throw new BadRequestException(`A senha do painel precisa de ao menos ${SENHA_MIN} caracteres.`)
    }
    if (s.toLowerCase() === email.toLowerCase() || /^(senha|password|admin|advocme)/i.test(s)) {
      throw new BadRequestException('Escolha uma senha que não seja adivinhável.')
    }
  }

  // ---- Segundo fator --------------------------------------------------------

  /**
   * Devolve o que o aplicativo precisa ler. Não liga nada ainda: ligar exige
   * provar que o aplicativo está funcionando.
   *
   * O segredo pendente é REAPROVEITADO em vez de sorteado de novo. Enquanto cada
   * chamada sorteava um, recarregar a página (ou clicar "Começar" duas vezes)
   * substituía em silêncio o segredo que o celular acabara de ler — e a partir
   * daí nenhum código funcionava, para sempre, sem nada na tela explicando.
   * Reaproveitar não custa segurança nenhuma: um segredo que ainda não foi
   * confirmado não protege nada, e continua sem valer até alguém provar que o
   * aplicativo o tem.
   */
  async iniciarTotp(quem: AdminAtual) {
    if (!quem.id) throw new BadRequestException('A credencial de emergência não tem segundo fator.')
    const conta = await this.prisma.adminUser.findUnique({ where: { id: quem.id } })
    if (!conta) throw new BadRequestException('Administrador não encontrado.')
    if (conta.totpEnabled) throw new BadRequestException('O segundo fator já está ligado.')

    const segredo = conta.totpSecret || novoSegredoTotp()
    if (segredo !== conta.totpSecret) {
      await this.prisma.adminUser.update({ where: { id: quem.id }, data: { totpSecret: segredo } })
    }
    return {
      segredo: segredoLegivel(segredo),
      otpauth: otpauthUrl(segredo, conta.email),
    }
  }

  /** Liga o segundo fator depois de o aplicativo provar que gera o código certo. */
  async ligarTotp(quem: AdminAtual, codigo: string, ip?: string) {
    if (!quem.id) throw new BadRequestException('A credencial de emergência não tem segundo fator.')
    const conta = await this.prisma.adminUser.findUnique({ where: { id: quem.id } })
    if (!conta?.totpSecret) throw new BadRequestException('Comece pelo passo anterior.')
    if (!totpConfere(conta.totpSecret, codigo)) {
      throw new BadRequestException('Código incorreto. Confira a hora do aparelho e tente o próximo.')
    }
    await this.prisma.adminUser.update({ where: { id: quem.id }, data: { totpEnabled: true } })
    await this.registrar(quem, {
      action: 'admin.totp-ligar',
      targetType: 'admin',
      targetId: quem.id,
      reason: 'segundo fator configurado',
      ip,
    })
    return { ok: true }
  }

  /** Desliga o segundo fator. Exige a senha E um código válido: quem estiver com
   *  a sessão de outra pessoa não desliga a proteção dela. */
  async desligarTotp(quem: AdminAtual, senha: string, codigo: string, ip?: string) {
    if (!quem.id) throw new BadRequestException('A credencial de emergência não tem segundo fator.')
    const conta = await this.prisma.adminUser.findUnique({ where: { id: quem.id } })
    if (!conta || !verifyPassword(senha ?? '', conta.passwordHash)) {
      throw new UnauthorizedException('Senha incorreta.')
    }
    if (!totpConfere(conta.totpSecret, codigo)) {
      throw new BadRequestException('Código incorreto.')
    }
    await this.prisma.adminUser.update({
      where: { id: quem.id },
      data: { totpEnabled: false, totpSecret: null },
    })
    await this.registrar(quem, {
      action: 'admin.totp-desligar',
      targetType: 'admin',
      targetId: quem.id,
      reason: 'segundo fator desligado pelo próprio administrador',
      ip,
    })
    return { ok: true }
  }

  // ---- O que o painel precisa saber ao abrir ---------------------------------

  async retrato(quem: AdminAtual) {
    return {
      csrfToken: quem.sessionId ? csrfTokenFor(quem.sessionId) : '',
      // O id vai junto para a tela saber qual linha da lista é a própria pessoa.
      // Comparar por NOME quebraria com dois administradores homônimos — e a
      // consequência seria a tela liberar botões que o servidor recusa.
      id: quem.id,
      name: quem.label,
      role: quem.role,
      permissoes: quem.totpPendente
        ? permissoesDe(quem.role).filter((p) => !decide(p))
        : permissoesDe(quem.role),
      totpPendente: quem.totpPendente,
      // Ainda não existe administrador nenhum: o painel avisa e oferece criar.
      emergencia: quem.emergencia,
      producao: IS_PROD,
    }
  }
}

/**
 * O que entra em `before`/`after`: JSON curto, só o que mudou.
 *
 * O teto de tamanho não é estética — é o que impede a trilha de auditoria de
 * virar uma segunda cópia do conteúdo dos perfis, com os problemas de retenção
 * que isso traria.
 */
function recorte(valor: unknown): string {
  if (valor === undefined || valor === null) return ''
  try {
    return JSON.stringify(valor).slice(0, 2000)
  } catch {
    return ''
  }
}
