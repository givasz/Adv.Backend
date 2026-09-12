// IndexNow — avisar o buscador que uma página mudou, em vez de esperar que ele
// volte.
//
// O Google só relê o sitemap quando quer (horas, dias). O Bing, o Yandex, o
// Seznam e o Naver aceitam um POST dizendo "estas URLs mudaram", e o Bing é o
// índice por trás do Copilot e da busca do ChatGPT — para o advogado, é a
// diferença entre o perfil novo aparecer hoje ou na semana que vem. O Google
// não participa (a Indexing API dele só aceita vaga de emprego e transmissão ao
// vivo); para ele, vale o sitemap com `lastmod` verdadeiro.
//
// Como funciona (https://www.indexnow.org/documentation):
//   • uma CHAVE (8–128 caracteres hex) publicada em `https://<site>/<chave>.txt`,
//     contendo a própria chave — é a prova de que quem avisa é o dono do site.
//     A nossa vive em frontend/public/ e é servida pelo Netlify; NÃO é segredo
//     (está numa URL pública por definição), é só a mesma string nos dois lados;
//   • um POST em api.indexnow.org com `host`, `key` e até 10.000 URLs. Um só
//     destino: os buscadores participantes repassam entre si.
//
// NUNCA SEGURA UM SAVE. O aviso é enfileirado e sai depois, num POST só a cada
// minuto (o editor salva com debounce, e cada save de perfil publicado é uma
// mudança; mandar a mesma URL dez vezes por minuto é o que a documentação pede
// para não fazer). Falhou? Paciência: o sitemap continua lá, e a próxima edição
// avisa de novo. Nada disto aparece para o advogado — é encanamento.
//
// DESLIGADO sem INDEXNOW_KEY, e sem SITE_URL/FRONTEND_ORIGIN em https: o
// endereço avisado tem de ser o público, e o arquivo da chave tem de estar
// nele. Em desenvolvimento, portanto, nunca sai nada.

import { urlDoSite } from '../mail/config'

const ESPERA_MS = 60_000
const DESTINO = 'https://api.indexnow.org/indexnow'
const PRAZO_MS = 8_000

interface Config {
  chave: string
  site: string
}

/** Configuração vigente, ou `null` quando o aviso está desligado. */
export function configIndexNow(env: NodeJS.ProcessEnv = process.env): Config | null {
  const chave = (env.INDEXNOW_KEY ?? '').trim()
  if (!/^[a-f0-9-]{8,128}$/i.test(chave)) return null
  const site = urlDoSite(env)
  if (!site.startsWith('https://')) return null
  return { chave, site }
}

/**
 * A fila. Caminhos (não URLs): `/ana-ribeiro`, `/escritorio/andrade-vieira`. A
 * origem entra na hora de enviar, de SITE_URL — nunca de um cabeçalho Host.
 */
const pendentes = new Set<string>()
let temporizador: ReturnType<typeof setTimeout> | null = null

/** Só para os testes: o que está esperando para sair. */
export function _pendentes(): string[] {
  return [...pendentes]
}

/** Só para os testes: esvazia a fila e desarma o temporizador. */
export function _limpar(): void {
  pendentes.clear()
  if (temporizador) clearTimeout(temporizador)
  temporizador = null
}

/**
 * Enfileira caminhos para avisar. Aceita qualquer coisa e descarta o que não é
 * caminho absoluto de site (`/…`) — quem chama passa slugs que já foram
 * saneados, mas a fila é a última barreira antes de um POST externo.
 */
export function avisarIndexNow(caminhos: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (!configIndexNow(env)) return
  for (const c of caminhos) {
    if (typeof c === 'string' && /^\/[a-z0-9\-/]*$/i.test(c)) pendentes.add(c)
  }
  if (pendentes.size && !temporizador) {
    temporizador = setTimeout(() => {
      temporizador = null
      void enviar(env)
    }, ESPERA_MS)
    // O processo não fica vivo por causa disto: um deploy no meio do minuto
    // perde o aviso, e o sitemap cobre.
    temporizador.unref?.()
  }
}

/** Manda o que está na fila, agora. Exportado para os testes e para o flush. */
export async function enviar(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const cfg = configIndexNow(env)
  if (!cfg || pendentes.size === 0) return false
  const lote = [...pendentes].slice(0, 10_000)
  for (const c of lote) pendentes.delete(c)
  const host = new URL(cfg.site).host
  try {
    const r = await fetch(DESTINO, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key: cfg.chave,
        keyLocation: `${cfg.site}/${cfg.chave}.txt`,
        urlList: lote.map((c) => `${cfg.site}${c}`),
      }),
      signal: AbortSignal.timeout(PRAZO_MS),
    })
    // 200 e 202 são aceite; 4xx é configuração errada (chave não bate com o
    // arquivo, host diferente) — vale um aviso no log, uma vez, e nada mais.
    if (!r.ok) console.warn(`[indexnow] ${r.status} ao avisar ${lote.length} endereço(s)`)
    return r.ok
  } catch (e) {
    console.warn(`[indexnow] falhou: ${(e as Error).message}`)
    return false
  }
}
