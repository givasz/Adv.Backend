# Verificação de OAB — plano de escalonamento

> Como o advoc.me confere que um perfil pertence a um advogado realmente inscrito e
> **regular** na OAB — de forma **em conformidade** com o Provimento 205/2021 (a marca é
> sempre a informativa **"OAB conferida"**, nunca um selo/chancela oficial da OAB).

## O problema tem duas partes

1. **Regularidade** — o número de inscrição existe e está **Regular** (não suspenso,
   licenciado ou cancelado).
2. **Titularidade** — a pessoa que está criando o perfil **é** aquele advogado (senão
   qualquer um usa o número real de outro e se passa por ele).

O CNA resolve o (1). O (2) exige um passo extra (e-mail oficial, carteira digital, foto).

## Fontes oficiais / ferramentas disponíveis

| Ferramenta | O que faz | Uso no advoc.me |
|---|---|---|
| **CNA** (`cna.oab.org.br`) | Busca pública por nome / nº / UF. Mostra nome, seccional e **situação**. | Conferência manual pelo admin. |
| **Web Service CNA** (`www5.oab.org.br/cnaws/service.asmx`) | SOAP: `ConsultaAdvogado(inscricao, uf, nome)`, `ConsultaAdvogadoPorCpf(cpf)`, `BuscaImagemAdvogado(numeroSeguranca)` → XML + **foto oficial**. | Assistente automático (fase 2) — **com ressalvas** (ver Riscos). |
| **ConfirmADV** (`confirmadv.oab.org.br`) | Plataforma **oficial**: informa nº + UF + e-mail do advogado → CNA + **e-mail de confirmação** ao advogado (5 min) → confirma regularidade **e titularidade**. | Meta de longo prazo (fase 3), via convênio. |
| **APIs de terceiros** ("consulta OAB") | Fazem o scraping do CNA por você (pagas). | Alternativa ao asmx se o oficial não for viável. |

## Fases

### Fase 1 — MVP: conferência manual por admin ✅ (implementado)

Fluxo:
1. Advogado preenche **nome + nº OAB + UF** e (opcional) faz upload da **carteira digital**.
2. Clica **"Solicitar conferência"** → `oabStatus: pending` (fila de análise).
3. Admin abre o CNA, busca por número+UF e confere: **nome bate** e **situação = Regular**.
   Compara a **foto/carteira** (anti-fraude de titularidade).
4. **Aprova** (`verified`, marca "OAB conferida") ou **Rejeita** (`rejected`, com motivo).
5. Tudo é gravado no **AuditLog** (quem/quando/decisão) para fiscalização.

Por quê primeiro: zero risco de integração, 100% confiável, volume baixo no início.

**Modelo de dados**

```
Profile.oabStatus : none | pending | verified | rejected   (default: none)
Profile.oabVerified : boolean  // espelha (oabStatus === 'verified') — usado na UI
AuditLog.action : "oab:request" | "oab:verified" | "oab:rejected"
```

**Endpoints**

```
POST /api/profiles/me/oab/request              # advogado solicita → pending
GET  /api/admin/oab/pending                     # fila (header x-admin-token)
POST /api/admin/profiles/:id/oab/decision       # { decision: verify|reject, reason? }
```

> A rota admin é protegida por um **token simples** (`x-admin-token` vs `ADMIN_TOKEN`)
> apenas no protótipo. Em produção: autenticação real + papel de admin.

### Fase 2 — Assistente automático (CNA web service)

O backend chama `ConsultaAdvogado(inscricao, uf, nome)` para **pré-preencher** e comparar
nome + situação, e `BuscaImagemAdvogado` para exibir a **foto oficial** ao lado do upload.
O admin passa a só **confirmar em segundos** (não some com a etapa humana — o serviço
apenas assiste).

- Fica **atrás de uma flag/env** (`OAB_CNA_WS_ENABLED`), desligado por padrão.
- Sempre com **fallback** para o manual se o serviço falhar.
- Ainda **não prova titularidade** — só acelera a regularidade.

### Fase 3 — Self-service oficial (ConfirmADV / convênio)

Integrar (ou emular, via convênio com a OAB) o fluxo do **ConfirmADV**: o próprio advogado
confirma a identidade por e-mail oficial da OAB. Resolve **regularidade + titularidade** sem
admin → verificação self-service e auditável. É o "gold standard".

## Riscos e cuidados

- **Web service do CNA**: aparenta endpoint interno (namespace `tempuri.org`, sem
  autenticação documentada). Pode ser restrito por IP/parceria, mudar/cair sem aviso e ter
  implicações de ToS. **Nunca depender dele sem fallback**; idealmente buscar autorização.
- **Titularidade**: CNA/web service provam que o número é de "Fulano", não que **quem
  cadastrou** é o Fulano. Exigir carteira digital (com foto) + revisão, ou ConfirmADV.
- **LGPD**: guardar o mínimo (nº OAB, nome, decisão). Uploads de documento em storage
  seguro e **descartados após a conferência**. Transmissão via HTTPS.
- **Conformidade OAB**: a marca é sempre **"OAB conferida"** (conferência da plataforma).
  Nunca usar selo/logo/brasão da OAB nem texto que insinue chancela oficial (Prov. 205/2021
  Art. 5º §2º). **Nunca** conceder "conferida" a partir de dado auto-declarado.

## Resumo da recomendação

Começar pelo **Fase 1 (manual + auditoria)** agora; adicionar o **assistente do CNA (Fase 2)**
atrás de flag quando o volume crescer; perseguir **ConfirmADV/convênio (Fase 3)** para
verificação oficial self-service.

**Fontes:** CNA (`cna.oab.org.br`) · Web Service (`www5.oab.org.br/cnaws/service.asmx`) ·
ConfirmADV (`confirmadv.oab.org.br`).
