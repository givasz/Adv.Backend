/** Só o webhook HMAC legado precisa dos bytes exatos recebidos. */
export function precisaPreservarCorpoCru(url: string | undefined): boolean {
  if (!url) return false
  return url.split('?', 1)[0] === '/api/billing/webhook'
}
