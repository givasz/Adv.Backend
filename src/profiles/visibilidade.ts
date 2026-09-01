// A regra de "este perfil pode ser visto por quem não está logado".
//
// ---------------------------------------------------------------------------
// POR QUE ELA MORA NUM ARQUIVO SÓ
//
// Era um método privado do ProfilesService, com um comentário que dizia:
//
//   "Virou método porque agora TRÊS portas devolvem perfil ao público (…). Se as
//    três escrevessem a condição à mão, bastaria uma esquecer o
//    `moderationStatus` para um perfil restrito voltar a circular pelo WhatsApp."
//
// O raciocínio estava certo e o número estava errado: as portas eram QUATRO. A
// quarta é a página pública do escritório (`GET /api/firms/:slug`), que mora em
// outro serviço e por isso não tinha como chamar um método privado — ela
// simplesmente não filtrava nada. O efeito, encontrado na auditoria de
// 01/09/2026:
//
//   • Perfil RESTRINGIDO pela moderação continuava na página do escritório, com
//     nome, foto, bio, OAB e WhatsApp. A sanção tirava o perfil do ar e a
//     sociedade seguia publicando o mesmo conteúdo.
//   • Perfil NUNCA PUBLICADO — rascunho de quem aceitou o convite e ainda não
//     terminou — aparecia para o mundo do mesmo jeito.
//
// Um método privado não é fronteira: ele protege quem consegue chamá-lo. Como
// função exportada, a regra fica ao alcance de qualquer serviço que precise dela,
// que é a única forma de a quinta porta nascer certa.
// ---------------------------------------------------------------------------

/**
 * Condição de `where` (Prisma) para um perfil visível ao público.
 *
 * Duas exigências, e a segunda tem prazo: a restrição da moderação vale enquanto
 * `moderationUntil` não passou. Vencer na LEITURA é de propósito — a medida se
 * desfaz sozinha na hora certa, sem depender de uma varredura ter rodado. Ver
 * admin/sancoes.ts.
 */
export function perfilVisivelAoPublico() {
  return {
    published: true,
    OR: [
      { moderationStatus: { not: 'restricted' as const } },
      { moderationUntil: { lte: new Date() } },
    ],
  }
}
