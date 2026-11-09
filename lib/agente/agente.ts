import "server-only";
import { casoPorId } from "../dados";
import { tratativaPorRegras } from "../regras";
import type { PassoAgente, RespostaAgente, Tratativa } from "../tipos";
import { definicoes, executar } from "./ferramentas";

const URL = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";
const MODELOS = (process.env.GROQ_MODELS ||
  "openai/gpt-oss-120b,llama-3.3-70b-versatile,meta-llama/llama-4-scout-17b-16e-instruct,llama-3.1-8b-instant")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_PASSOS = 6;

const SISTEMA = `Você é o agente de tratativas do time de Operações da Gocase e da GoBeauté.
Sua tarefa: investigar UM pedido com exceção e registrar a melhor tratativa, que será executada de verdade.

Como trabalhar:
1. Na primeira resposta, chame juntas: consultar_pedido, verificar_causa_sistemica e calcular_opcoes. Chame consultar_cliente (com o customer_id do pedido) e consultar_transportadora se ajudarem a decidir.
2. Decida com base nos números das ferramentas, nunca invente valores. Reenviar custa CMV (24% do valor) + frete; reembolsar custa o valor pago e aumenta a chance de perder o cliente.
3. Termine chamando registrar_tratativa uma única vez. A ação principal deve estar entre as opções de calcular_opcoes. Siga a ação padrão do playbook, a não ser que os dados mostrem um motivo claro para outra; se mudar, explique na justificativa.

Regras de negócio:
- Probabilidade de cancelamento por dias úteis de atraso sobre o prazo prometido: 1-2: 4%, 3-5: 10%, 6-10: 22%, >10: 40%.
- Cliente com receita acumulada acima de R$ 1.500 recompra em 70% dos casos, os demais em 28%. Exceção mal resolvida corta isso pela metade.
- Falha de personalização exige produzir de novo; nunca na impressora IMP-02 se ela for a causa.
- Se o caso faz parte de um problema recorrente, preencha alerta_processo com o que precisa mudar.
- Mensagem ao cliente: português do Brasil, tom humano, até 3 frases, sem prometer datas que dependem da transportadora. Não use o nome do cliente (não temos).
- Seja breve: nada de texto fora das chamadas de ferramenta.`;

type Msg = Record<string, any>;

async function chamarLLM(modelo: string, mensagens: Msg[], chave: string) {
  const corpo: Record<string, unknown> = {
    model: modelo,
    messages: mensagens,
    tools: definicoes,
    tool_choice: "auto",
    temperature: 0.2,
    max_tokens: 1400,
  };
  if (modelo.startsWith("openai/gpt-oss")) corpo.reasoning_effort = "low";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text();
      const e = new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`) as Error & { status?: number };
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    return j.choices?.[0]?.message as Msg;
  } finally {
    clearTimeout(t);
  }
}

/** Investigação determinística: usada quando a IA não está disponível, para o trace continuar mostrando o que foi consultado. */
function investigacaoPorRegras(orderId: string): PassoAgente[] {
  const c = casoPorId(orderId)!;
  const chamadas: [string, Record<string, unknown>][] = [
    ["consultar_pedido", { order_id: c.order_id }],
    ["consultar_cliente", { customer_id: c.customer_id }],
    ["consultar_transportadora", { transportadora: c.transportadora, uf: c.uf }],
    ["verificar_causa_sistemica", { order_id: c.order_id }],
    ["calcular_opcoes", { order_id: c.order_id }],
  ];
  return chamadas.map(([nome, argumentos]) => ({ tipo: "ferramenta", nome, argumentos, resultado: executar(nome, argumentos).resultado }));
}

export async function rodarAgente(orderId: string): Promise<RespostaAgente> {
  const inicio = Date.now();
  const caso = casoPorId(orderId);
  if (!caso) throw new Error("Pedido não encontrado na fila de exceções.");
  const chave = process.env.GROQ_API_KEY;
  const passos: PassoAgente[] = [];

  const porRegras = (aviso: string): RespostaAgente => ({
    modo: "regras",
    modelo: null,
    passos: [...passos.filter((p) => p.tipo === "aviso"), { tipo: "aviso", texto: aviso }, ...investigacaoPorRegras(caso.order_id)],
    tratativa: tratativaPorRegras(caso),
    aviso,
    duracao_ms: Date.now() - inicio,
  });

  if (!chave) return porRegras("Sem chave de IA configurada (GROQ_API_KEY). A tratativa foi montada pelo playbook de regras.");

  const mensagens: Msg[] = [
    { role: "system", content: SISTEMA },
    { role: "user", content: `Trate o pedido ${caso.order_id} (cliente ${caso.customer_id}). Data de referência: 30/09/2026.` },
  ];
  let modeloIdx = 0;
  let tratativa: Tratativa | undefined;
  let cobrancas = 0;

  for (let passo = 0; passo < MAX_PASSOS && !tratativa; passo++) {
    let msg: Msg | undefined;
    while (!msg && modeloIdx < MODELOS.length) {
      try {
        msg = await chamarLLM(MODELOS[modeloIdx], mensagens, chave);
      } catch (e: any) {
        const st = e?.status;
        const motivo = st === 429 ? "limite gratuito atingido" : st === 404 || st === 400 ? "modelo recusou a chamada" : st ? `erro ${st}` : "sem resposta";
        passos.push({ tipo: "aviso", texto: `Modelo ${MODELOS[modeloIdx]}: ${motivo}. O próximo modelo assumiu.` });
        console.error("[agente]", MODELOS[modeloIdx], String(e?.message ?? e).slice(0, 300));
        modeloIdx++;
      }
    }
    if (!msg) return porRegras("Nenhum modelo de IA respondeu (limite gratuito ou instabilidade). A tratativa foi montada pelo playbook de regras.");

    const chamadas = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
    mensagens.push({ role: "assistant", content: msg.content ?? "", ...(chamadas.length ? { tool_calls: chamadas } : {}) });
    if (msg.content && String(msg.content).trim()) passos.push({ tipo: "pensamento", texto: String(msg.content).trim() });

    if (!chamadas.length) {
      if (++cobrancas > 2) break;
      mensagens.push({ role: "user", content: "Registre a decisão agora chamando registrar_tratativa." });
      continue;
    }
    for (const ch of chamadas) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(ch.function.arguments || "{}");
      } catch {
        args = {};
      }
      const { resultado, tratativa: t } = executar(ch.function.name, args);
      passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado });
      mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(resultado) });
      if (t) tratativa = t;
    }
  }

  if (!tratativa) return porRegras("A IA não fechou a decisão a tempo. A tratativa foi montada pelo playbook de regras.");
  return { modo: "ia", modelo: MODELOS[modeloIdx], passos, tratativa, duracao_ms: Date.now() - inicio };
}
