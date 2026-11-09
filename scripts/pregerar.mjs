// Pré-gera com a IA as tratativas dos primeiros casos da fila e salva em lib/data/pregerados.json.
// Uso (com o app rodando, local ou publicado): node scripts/pregerar.mjs [url_base] [quantidade]
//   node scripts/pregerar.mjs http://localhost:3000 15
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:3000";
const N = Number(process.argv[3] || 15);
const SAIDA = new URL("../lib/data/pregerados.json", import.meta.url);
const casos = JSON.parse(readFileSync(new URL("../lib/data/casos.json", import.meta.url), "utf8"));
const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));

const alvo = casos
  .filter((c) => c.fila === "humana" && c.prioridade)
  .sort((a, b) => a.prioridade - b.prioridade)
  .slice(0, N)
  .map((c) => c.order_id);

const saida = {};
for (const [i, id] of alvo.entries()) {
  for (let tentativa = 1; tentativa <= 8; tentativa++) {
    const r = await fetch(`${BASE}/api/agente`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: id, refazer: true }),
    }).then((x) => x.json());
    if (r.modo === "ia") {
      saida[id] = { ...r, gerado_em: new Date().toISOString() };
      console.log(`${i + 1}/${alvo.length} ${id}: ${r.modelo}, ${r.tratativa.acao} (${r.tratativa.executor})`);
      writeFileSync(SAIDA, JSON.stringify(saida, null, 1) + "\n");
      if (r.espera_s) await dormir(r.espera_s);
      break;
    }
    const espera = r.espera_s || 20;
    console.log(`${i + 1}/${alvo.length} ${id}: sem IA (${r.aviso ?? r.erro}); esperando ${espera}s`);
    await dormir(espera);
  }
  if (!saida[id]) console.log(`${id}: ficou sem tratativa pré-gerada`);
}
console.log(`\n${Object.keys(saida).length} de ${alvo.length} casos salvos em lib/data/pregerados.json`);
