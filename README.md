# Dashboard de Acurácia de Estoque — ERP × WMS

Sistema de monitoramento de acurácia de inventário construído para operação de e-commerce/varejo, comparando saldos entre ERP (Protheus) e WMS em tempo real, com alertas automáticos de divergência.

## Problema resolvido

Operações de estoque multi-filial sofrem com **divergências entre sistemas** (ERP vs. WMS) que geram:
- Rupturas não identificadas
- Erros de faturamento por saldo incorreto
- Retrabalho manual de conferência

Este projeto automatiza a detecção, quantificação e visualização dessas divergências.

## Arquitetura

```
n8n (orquestração)  →  Cloudflare Worker (API + storage)  →  Dashboard (HTML/JS/Chart.js)
     ↓                          ↓
  Metabase (ERP)          SQLite (snapshots
  Google Drive (WMS)       versionados,
                            chunked p/ payloads grandes)
```

- **`src/index.ts`** — Worker (Cloudflare Workers runtime) que expõe:
  - `POST /api/ingest` — recebe snapshot normalizado (autenticado via Bearer token)
  - `GET /api/data` — retorna o snapshot atual consolidado
  - `GET /api/snapshots` — histórico dos últimos 30 snapshots
  - `GET /api/health` — healthcheck
- **`public/index.html`** — dashboard front-end: KPIs de acurácia, Pareto de divergências financeiras, heatmap Filial × Curva ABC, match contábil (quantitativo e financeiro), tabela detalhada por SKU com paginação e exportação CSV.

## Detalhes técnicos relevantes

- **Chunking de payload**: como o D1 (SQLite do Cloudflare) tem limite de ~1MB por linha, o payload de ingestão é dividido em chunks de 900KB e remontado na leitura — resolve `SQLITE_TOOBIG` em bases de estoque com dezenas de milhares de SKUs.
- **Normalização defensiva**: `normalizeRow()` aceita múltiplas variações de nome de coluna (ex: `SALDO PROTHEUS`, `Saldo ERP`, `saldo_protheus`) para tolerar mudanças de schema na fonte.
- **Cálculo de acurácia** em duas dimensões: por unidade (`1 - divergência_absoluta/estoque_total`) e por SKU (`SKUs sem divergência / total SKUs`).
- **Match contábil líquido**: `|Σ falta| - |Σ sobra|`, tanto em unidades quanto em R$, para identificar se a divergência é estrutural ou apenas de timing.

## Pipeline de dados (n8n)

Dois workflows agendados alimentam este Worker via `/api/ingest`:
1. **23h35** — extrai saldo ERP do Metabase, agrega quantidades (disponível + reservada + empenhada)
2. **09h00** (dia seguinte) — extrai saldo WMS de um XLSX no Drive, cruza com o ERP do dia anterior, calcula divergências por curva ABC e dispara alerta no Google Chat quando a divergência ultrapassa o limiar da curva (AA/A: 1.000un · B: 300un · C: 200un)

> Os workflows n8n completos (JSON exportável) estão no repositório [`n8n-workflows-estoque`](#).

## Stack

`TypeScript` · `Cloudflare Workers` · `SQLite (D1)` · `Chart.js` · `n8n` · `Google Sheets/Drive API` · `Metabase API`

## Nota

Este repositório contém o código-fonte extraído de um projeto em produção, com identificadores internos (IDs de planilha, tokens, webhooks) removidos/substituídos por placeholders para publicação.
