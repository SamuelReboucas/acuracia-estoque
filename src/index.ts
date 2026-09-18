// ─────────────────────────────────────────────────────────────────────────────
// Dashboard gobeaute — Worker  (fix SQLITE_TOOBIG: chunked data_json)
// Routes: GET /api/health  POST /api/ingest  GET /api/data  GET /api/snapshots
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_DEFAULT = "APURACAO_ESTOQUE";
const MAX_SNAPSHOTS  = 30;
const WARN_THRESHOLD = 1000;
const CHUNK_BYTES    = 900_000; // 900 KB por chunk — abaixo do limite de 1 MB do D1

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function ensureSchema(db: any): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      total        INTEGER NOT NULL,
      data_json    TEXT    NOT NULL DEFAULT '',
      is_current   INTEGER NOT NULL DEFAULT 0,
      is_valid     INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL,
      chunk_index  INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 1
    )
  `, []);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_source_current ON snapshots(source, is_current)`, []);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_source_updated ON snapshots(source, updated_at)`,  []);
  try { await db.exec(`ALTER TABLE snapshots ADD COLUMN chunk_index  INTEGER NOT NULL DEFAULT 0`, []); } catch {}
  try { await db.exec(`ALTER TABLE snapshots ADD COLUMN total_chunks INTEGER NOT NULL DEFAULT 1`, []); } catch {}
}

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/\s/g, "");
  s = s.replace(/R\$\s*/gi, "").replace(/%$/, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  if (s.startsWith("#N/A")) return "N/A";
  if (s.startsWith("#"))    return "N/A";
  return s;
}

interface NormalizedRow {
  sku:            string;
  descricao:      string;
  filial:         string;
  marca:          string;
  curva:          string;
  gtin:           string;
  cnpj:           string;
  saldo_protheus: number;
  saldo_wms:      number;
  divergencia:    number;
  div_abs:        number;
  valor_un:       number;
  valor_div:      number;
  estoque:        number;
  falta:          number;
  sobra:          number;
  status:         string;
  status_produto: string;
  acuracidade_sku: number;
}

function normalizeRow(raw: Record<string, unknown>): NormalizedRow {
  const sku       = toStr(raw["SKU"]               ?? raw["sku"]       ?? raw["Sku"]);
  const descricao = toStr(raw["Descricao_Produto"]  ?? raw["descricao"] ?? raw["Descricao"] ?? raw["DESCRICAO"] ?? raw["Descrição"]);
  const filial    = toStr(raw["FILIAL"]             ?? raw["filial"]    ?? raw["Filial"]);
  const marca     = toStr(raw["Marca"]              ?? raw["marca"]     ?? raw["MARCA"]);
  const curva     = toStr(raw["Curva"]              ?? raw["curva"]     ?? raw["CURVA"]);
  const gtin      = toStr(raw["GTIN"]               ?? raw["gtin"]      ?? "");
  const cnpj      = toStr(raw["cnpj"]               ?? raw["CNPJ"]      ?? "");

  const saldo_protheus = toNum(
    raw["SALDO PROTHEUS"] ?? raw["Saldo ERP"]     ??
    raw["saldo_protheus"] ?? raw["SALDO_PROTHEUS"] ?? raw["estoque"]
  );

  const saldo_wms = toNum(
    raw["Saldo Físico"]   ?? raw["Saldo Fisico"]  ??
    raw["SALDO WMS"]      ?? raw["saldo_wms"]     ??
    raw["SALDO_WMS"]      ?? raw["SaldoFisico"]
  );

  const divergencia = saldo_wms - saldo_protheus;
  const div_abs     = Math.abs(divergencia);

  const valor_un  = toNum(raw["VALOR_UN"]    ?? raw["valor_un"]  ?? raw["Valor Unitário"]);
  const valor_div = toNum(
    raw["VALOR_DIVER"] ?? raw["VALOR_DIV"]  ??
    raw["valor_div"]   ?? raw["Valor Divergência"]
  ) || (divergencia * valor_un);

  const status_produto = toStr(raw["Status"] ?? raw["status_produto"] ?? "");

  let status: string;
  if (status_produto.toLowerCase() === "descontinuado") {
    status = "Fora de escopo";
  } else if (divergencia === 0) {
    status = "OK";
  } else if (divergencia > 0) {
    status = "SOBRA FÍSICA";
  } else {
    status = "FALTA FÍSICA";
  }

  const acuracidade_sku = toNum(raw["ACURACIDADE_SKU"] ?? raw["acuracidade_sku"] ?? 0);
  const estoque = saldo_protheus;
  const falta   = divergencia < 0 ? div_abs : 0;
  const sobra   = divergencia > 0 ? divergencia : 0;

  return {
    sku, descricao, filial, marca, curva, gtin, cnpj,
    saldo_protheus, saldo_wms, divergencia, div_abs,
    valor_un, valor_div,
    estoque, falta, sobra,
    status, status_produto, acuracidade_sku,
  };
}

async function getCurrentSnapshot(db: any, source: string) {
  const res = await db.query(
    `SELECT source, updated_at, total, data_json, created_at, chunk_index, total_chunks
       FROM snapshots
      WHERE source = ? AND is_current = 1 AND is_valid = 1
      ORDER BY chunk_index ASC`,
    [source]
  );
  if (res.rows.length === 0) return null;
  const first    = res.rows[0];
  const data_json = (res.rows as any[]).map((r: any) => r.data_json).join("");
  return {
    source:      first.source,
    updated_at:  first.updated_at,
    total:       first.total,
    data_json,
    created_at:  first.created_at,
    total_chunks: first.total_chunks,
  };
}

async function getSnapshotMeta(db: any, source: string) {
  const res = await db.query(
    `SELECT updated_at, total FROM snapshots
      WHERE source = ? AND is_current = 1 AND is_valid = 1
      ORDER BY id DESC LIMIT 1`,
    [source]
  );
  return res.rows[0] ?? null;
}

async function handleHealth(db: any): Promise<Response> {
  await ensureSchema(db);
  const snap = await getSnapshotMeta(db, SOURCE_DEFAULT);
  return json({
    ok: true, service: "dashboard-gobeaute-worker",
    now: new Date().toISOString(),
    has_current_snapshot: snap !== null,
    current_total: snap ? snap.total : 0,
    current_updated_at: snap ? snap.updated_at : null,
  });
}

async function handleIngest(request: Request, db: any, env: any): Promise<Response> {
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: any;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body" }, 400); }

  let rawRows: unknown = body.rows;

  if (typeof rawRows === "string") {
    try { rawRows = JSON.parse(rawRows); }
    catch { return json({ ok: false, error: "rows é uma string mas não é JSON válido." }, 400); }
  }

  if (!Array.isArray(rawRows))   return json({ ok: false, error: "rows must be an array" }, 400);
  if (rawRows.length === 0)      return json({ ok: false, error: "rows array is empty" }, 400);

  const source     = typeof body.source === "string" && body.source ? body.source : SOURCE_DEFAULT;
  const updated_at = typeof body.updated_at === "string" && body.updated_at
    ? body.updated_at : new Date().toISOString();

  const rows: NormalizedRow[] = (rawRows as Record<string, unknown>[]).map(normalizeRow);

  const warnings: string[] = [];
  if (rows.length < WARN_THRESHOLD) {
    warnings.push(`Payload possui apenas ${rows.length} linha(s).`);
  }

  try {
    await ensureSchema(db);

    const fullJson    = JSON.stringify(rows);
    const chunks: string[] = [];
    for (let i = 0; i < fullJson.length; i += CHUNK_BYTES) {
      chunks.push(fullJson.slice(i, i + CHUNK_BYTES));
    }

    const created_at  = new Date().toISOString();

    await db.exec(`UPDATE snapshots SET is_current = 0 WHERE source = ? AND is_current = 1`, [source]);

    for (let ci = 0; ci < chunks.length; ci++) {
      await db.exec(
        `INSERT INTO snapshots (source, updated_at, total, data_json, is_current, is_valid, created_at, chunk_index, total_chunks)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
        [source, updated_at, rows.length, chunks[ci], created_at, ci, chunks.length]
      );
    }

    await db.exec(`
      DELETE FROM snapshots
       WHERE source = ?
         AND updated_at NOT IN (
           SELECT DISTINCT updated_at FROM snapshots
            WHERE source = ?
            ORDER BY updated_at DESC
            LIMIT ?
         )
    `, [source, source, MAX_SNAPSHOTS]);

    return json({
      ok: true, source,
      inserted: rows.length,
      chunks: chunks.length,
      updated_at, warnings,
      sample: rows.slice(0, 2),
    });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
}

async function handleData(db: any): Promise<Response> {
  await ensureSchema(db);
  const snap = await getCurrentSnapshot(db, SOURCE_DEFAULT);
  if (!snap) {
    return json({ ok: true, source: SOURCE_DEFAULT, updated_at: null, total: 0, rows: [] });
  }
  let rows: NormalizedRow[] = [];
  try {
    rows = JSON.parse(snap.data_json);
    rows = rows.map((r: any) => ({ ...r, curva: toStr(r.curva), status: toStr(r.status) }));
  } catch { rows = []; }
  return json({ ok: true, source: snap.source, updated_at: snap.updated_at, total: snap.total, rows });
}

async function handleSnapshots(db: any): Promise<Response> {
  await ensureSchema(db);
  const res = await db.query(
    `SELECT source, updated_at, MAX(total) as total,
            MAX(is_current) as is_current, MAX(is_valid) as is_valid,
            MIN(created_at) as created_at, MAX(total_chunks) as total_chunks
       FROM snapshots
      GROUP BY source, updated_at
      ORDER BY updated_at DESC LIMIT 10`,
    []
  );
  return json({ ok: true, snapshots: res.rows });
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url      = new URL(request.url);
    const pathname = url.pathname;
    const method   = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      if (pathname === "/api/health"    && method === "GET")  return handleHealth(env.DB);
      if (pathname === "/api/ingest"    && method === "POST") return handleIngest(request, env.DB, env);
      if (pathname === "/api/data"      && method === "GET")  return handleData(env.DB);
      if (pathname === "/api/snapshots" && method === "GET")  return handleSnapshots(env.DB);
      return json({ ok: false, error: "Not found" }, 404);
    } catch (err: any) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  },
};
