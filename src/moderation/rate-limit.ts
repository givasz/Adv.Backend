// O limitador passou a viver em src/security/rate-limit.ts, junto com as demais
// defesas transversais (cabeçalhos, IP do cliente, saneamento). Este arquivo
// segue existindo só para não quebrar quem já importava daqui.
export { checkRateLimit, REPORT_RATE_RULES, type Rule } from '../security/rate-limit'
