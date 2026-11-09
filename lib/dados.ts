import "server-only";
import casosJson from "./data/casos.json";
import resumoJson from "./data/resumo.json";
import transpJson from "./data/transportadoras.json";
import pregeradosJson from "./data/pregerados.json";
import type { Achado, Caso, RespostaAgente } from "./tipos";

/** Tratativas que a IA já gerou para os primeiros casos da fila (scripts/pregerar.mjs). */
const pregerados = pregeradosJson as unknown as Record<string, RespostaAgente>;
export const pregeradoPorId = (id: string): RespostaAgente | undefined => pregerados[id.trim().toUpperCase()];
export const idsPregerados = Object.keys(pregerados);

export const casos = casosJson as unknown as Caso[];
export const resumo = resumoJson as unknown as { kpis: Record<string, any>; achados: Achado[] };
export const transportadoras = transpJson as unknown as {
  transportadora: string;
  uf_atendida: string;
  sla_contratado_dias_uteis: number;
  custo_medio_frete: number;
}[];

const porId = new Map(casos.map((c) => [c.order_id, c]));
export const casoPorId = (id: string) => porId.get(id.trim().toUpperCase());

export const casosDoCliente = (customerId: string) => casos.filter((c) => c.customer_id === customerId);

/** Versão enxuta para a lista no navegador. */
export function casosResumidos() {
  return casos.map((c) => ({
    order_id: c.order_id,
    marca: c.marca,
    tipo_excecao: c.tipo_excecao,
    status: c.status,
    valor: c.valor,
    uf: c.uf,
    transportadora: c.transportadora,
    atraso_du: c.atraso_du,
    cliente_vip: c.cliente_vip,
    perda_hoje: c.perda_hoje,
    perda_5d: c.perda_5d,
    custo_espera: c.custo_espera,
    score: c.score,
    fila: c.fila,
    prioridade: c.prioridade,
    dia_previsto: c.dia_previsto,
    duplicado: c.duplicado,
    data_abertura_excecao: c.data_abertura_excecao,
    causas: (Object.keys(c) as (keyof Caso)[]).filter((k) => String(k).startsWith("causa_") && c[k]) as string[],
  }));
}
export type CasoResumido = ReturnType<typeof casosResumidos>[number];
