// Pré-gera com a IA as tratativas dos primeiros casos da fila e salva em lib/data/pregerados.json.
// Rode com o app local apontando para um modelo só (GROQ_MODELS) e nunca contra o link público:
// a cota do Groq é a mesma e é dividida com quem estiver usando o app.
//
//   node scripts/pregerar.mjs <url_base> <quantidade> <orcamento_tokens>
//   node scripts/pregerar.mjs http://localhost:3000 50 100000
//
// - pula os casos que já têm tratativa gerada pela versão atual do agente (ferramenta investigar_caso)
// - soma os tokens que o Groq informa e para antes de passar do orçamento (padrão: metade do limite diário)
// - para na hora se a cota diária acabar
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3000";
const N = Number(process.argv[3] || 15);
const ORCAMENTO = Number(process.argv[4] || 100_000);
const MARGEM = 8_000; // um caso nunca passou disso
if (/vercel\.app/.test(BASE)) throw new Error("Não rode a pré-geração contra o link público.");

const SAIDA = new URL("../lib/data/pregerados.json", import.meta.url);
const casos = JSON.parse(readFileSync(new URL("../lib/data/casos.json", import.meta.url), "utf8"));
const saida = existsSync(SAIDA) ? JSON.parse(readFileSync(SAIDA, "utf8")) : {};
const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));
const atual = (r) => r?.passos?.some((p) => p.nome === "investigar_caso");

const alvo = casos
  .filter((c) => c.fila === "humana" && c.prioridade)
  .sort((a, b) => a.prioridade - b.prioridade)
  .slice(0, N)
  .map((c) => c.order_id)
  .filter((id) => !atual(saida[id]));

const gasto = {};
const total = () => Object.values(gasto).reduce((a, b) => a + b, 0);
console.log(`${alvo.length} casos a gerar, orçamento de ${ORCAMENTO.toLocaleString("pt-BR")} tokens`);

fora: for (const [i, id] of alvo.entries()) {
  if (total() + MARGEM > ORCAMENTO) {
    console.log(`Orçamento atingido (${total().toLocaleString("pt-BR")} tokens). Parando.`);
    break;
  }
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    const r = await fetch(`${BASE}/api/agente`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: id, refazer: true }),
    }).then((x) => x.json());
    for (const [m, t] of Object.entries(r.tokens ?? {})) gasto[m] = (gasto[m] ?? 0) + t;
    if (r.modo === "ia") {
      saida[id] = { ...r, gerado_em: new Date().toISOString() };
      writeFileSync(SAIDA, JSON.stringify(saida, null, 1) + "\n");
      const t = Object.values(r.tokens ?? {}).reduce((a, b) => a + b, 0);
      console.log(`${i + 1}/${alvo.length} ${id}: ${r.modelo}, ${r.tratativa.acao} (${r.tratativa.executor}), ${t} tokens; total ${total()}`);
      await dormir(Math.max(r.espera_s ?? 0, 20));
      break;
    }
    if (r.limite === "dia") {
      console.log(`${id}: cota diária esgotada (${r.aviso}). Parando.`);
      break fora;
    }
    const espera = r.espera_s || 30;
    console.log(`${i + 1}/${alvo.length} ${id}: sem IA (${r.aviso ?? r.erro}); esperando ${espera}s`);
    await dormir(espera);
  }
}
console.log(`\nTokens gastos nesta rodada: ${JSON.stringify(gasto)} (total ${total()})`);
console.log(`${Object.values(saida).filter(atual).length} casos com tratativa da versão atual em lib/data/pregerados.json`);
