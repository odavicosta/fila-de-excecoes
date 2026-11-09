import "server-only";
import { casoPorId } from "../dados";
import { tratativaPorRegras } from "../regras";
import type { PassoAgente, RespostaAgente, Tratativa } from "../tipos";
import { definicoes, entregueComProblema, executar } from "./ferramentas";

const URL = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";
// Modelos do Groq com tool calling disponíveis no plano gratuito (cada um tem cota própria de tokens por minuto).
// O 20b vem primeiro: nos testes ele fechou todos os casos em 5-9 s; o 120b gastava a cota de 8k tokens/min
// e muitas vezes respondia a decisão em texto ou com chamada malformada em vez de registrar.
const MODELOS = (process.env.GROQ_MODELS || "openai/gpt-oss-20b,openai/gpt-oss-120b,qwen/qwen3.8-27b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_PASSOS = 6;
/** Se o 429 pede para esperar no máximo isso, espera e tenta o mesmo modelo de novo em vez de trocar. */
const ESPERA_MAX_S = 6;

const AVISO_COTA = "A cota gratuita de IA acabou por agora; esta tratativa veio do playbook. Tente de novo em 1 minuto.";

const CONTRADIZ_ALCADA =
  /(dentro d[ao] (limite|alçada)|alçada do agente|(execut[áa]vel|executad[ao]|executa[r]?)\s+(pelo|por|o)?\s*agente|agente\s+(executa|pode executar|resolve)|sozinho)/i;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lê o "Please try again in 3.95s" da mensagem de limite do Groq. */
function segundosParaTentar(msg: string): number | null {
  const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(msg);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
}

/** "7.66s", "1m2.5s", "120ms" -> segundos */
function lerDuracao(s: string | null): number | null {
  if (!s) return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 1000;
}

// Cota de tokens por minuto de cada modelo, lida dos cabeçalhos do Groq. Vale para a instância do servidor;
// se ela não souber de algo, o 429 corrige.
const TOKENS_POR_CASO = 6000;
/** Quando o modelo volta a ter TOKENS_POR_CASO livres (ms desde epoch). */
const cotas = new Map<string, number>();

/** A cota do Groq repõe o limite por minuto de forma contínua: com R restantes de L, faltam (6000 - R) / L minutos. */
function registrarCota(modelo: string, h: Headers): boolean {
  const restantes = Number(h.get("x-ratelimit-remaining-tokens"));
  const limite = Number(h.get("x-ratelimit-limit-tokens"));
  if (!h.has("x-ratelimit-remaining-tokens") || !Number.isFinite(restantes) || !(limite > 0)) {
    const reset = lerDuracao(h.get("x-ratelimit-reset-tokens"));
    if (reset === null) return false;
    cotas.set(modelo, Date.now() + reset * 1000);
    return true;
  }
  cotas.set(modelo, Date.now() + (Math.max(0, TOKENS_POR_CASO - restantes) / limite) * 60_000);
  return true;
}

/** Segundos até algum modelo ter cota para um caso inteiro (0 = pode rodar já). */
export function esperaParaProximoCaso(): number {
  let menor = Infinity;
  for (const m of MODELOS) {
    const livreEm = cotas.get(m);
    if (livreEm === undefined) return 0;
    menor = Math.min(menor, livreEm - Date.now());
  }
  return Math.max(0, Math.ceil(menor / 1000));
}

const SISTEMA = `Você é o agente de tratativas do time de Operações da Gocase e da GoBeauté.
Sua tarefa: investigar UM pedido com exceção e registrar a melhor tratativa, que será executada de verdade.

Como trabalhar:
1. Na primeira resposta, chame juntas: consultar_pedido, verificar_causa_sistemica e calcular_opcoes. Chame consultar_cliente (com o customer_id do pedido) e consultar_transportadora se ajudarem a decidir.
2. Decida com base nos números das ferramentas, nunca invente valores. Reenviar custa CMV (24% do valor) + frete; reembolsar custa o valor pago e aumenta a chance de perder o cliente.
3. Termine chamando registrar_tratativa uma única vez. A ação principal deve estar entre as opções de calcular_opcoes. Siga a ação padrão do playbook, a não ser que os dados mostrem um motivo claro para outra; se mudar, explique na justificativa.
4. Na justificativa, não diga quem executa nem fale de alçada ou limite: o sistema calcula isso e mostra à parte. Fale do problema, dos números e do porquê da ação.

Regras de negócio:
- Probabilidade de cancelamento por dias úteis de atraso sobre o prazo prometido: 1-2: 4%, 3-5: 10%, 6-10: 22%, >10: 40%.
- Cliente com receita acumulada acima de R$ 1.500 recompra em 70% dos casos, os demais em 28%. Exceção mal resolvida corta isso pela metade.
- Falha de personalização exige produzir de novo; nunca na impressora IMP-02 se ela for a causa.
- Se o caso faz parte de um problema recorrente, preencha alerta_processo com o que precisa mudar.
- Mensagem ao cliente: português do Brasil, tom humano, até 3 frases, sem prometer datas que dependem da transportadora. Comece com "Oi! Aqui é do time <marca do pedido>.", cite o número do pedido e descreva o problema real dele (o tipo_excecao: vazamento, item faltante etc., não "atraso" se não for atraso). Não use o nome do cliente (não temos).
- Se consultar_pedido diz situacao_entrega "entregue com problema", o pedido CHEGOU: na mensagem e na justificativa fale do problema (vazamento, avaria, item faltante) e dos dias úteis sem solução. Nunca diga que o pedido está atrasado ou com atraso.
- chamado_interno: deixe vazio, a não ser que precise de algo além do chamado padrão; o sistema gera o chamado para transportadora, CD ou produção com pedido, SKU, lote e prazo.
- Seja breve: nada de texto fora das chamadas de ferramenta.`;

type Msg = Record<string, any>;

async function chamarLLM(modelo: string, mensagens: Msg[], chave: string) {
  const corpo: Record<string, unknown> = {
    model: modelo,
    messages: mensagens,
    tools: definicoes,
    // Todo turno deste agente é uma chamada de ferramenta; sem isso o gpt-oss às vezes responde a decisão em texto
    // e gasta uma rodada extra (e a cota de tokens por minuto) só para ser cobrado a registrar.
    tool_choice: "required",
    temperature: 0.2,
    // O qwen gasta parte do limite raciocinando; com 1400 a justificativa do GB7004923 saiu cortada no meio.
    max_tokens: modelo.startsWith("qwen/") ? 4000 : 1400,
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
    const leuCota = registrarCota(modelo, r.headers);
    if (!r.ok) {
      const txt = await r.text();
      const e = new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`) as Error & { status?: number; leuCota?: boolean };
      e.status = r.status;
      e.leuCota = leuCota;
      throw e;
    }
    const j = await r.json();
    const escolha = j.choices?.[0];
    if (escolha && !escolha.message?.tool_calls?.length)
      console.error("[agente]", modelo, "resposta sem ferramenta:", escolha.finish_reason, String(escolha.message?.content ?? "").slice(0, 200));
    return escolha?.message as Msg;
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
  // Tolera erros comuns ao colar a chave no painel (espaços, quebra de linha, aspas, "GROQ_API_KEY=" junto).
  const chave = (process.env.GROQ_API_KEY ?? "").trim().replace(/^GROQ_API_KEY=/, "").replace(/^["']|["']$/g, "").trim();
  const passos: PassoAgente[] = [];

  const porRegras = (aviso: string): RespostaAgente => ({
    modo: "regras",
    modelo: null,
    passos: [...passos.filter((p) => p.tipo === "aviso"), { tipo: "aviso", texto: aviso }, ...investigacaoPorRegras(caso.order_id)],
    tratativa: tratativaPorRegras(caso),
    aviso,
    duracao_ms: Date.now() - inicio,
  });

  if (!chave) return porRegras("Sem chave de IA configurada (GROQ_API_KEY); esta tratativa veio do playbook.");

  const mensagens: Msg[] = [
    { role: "system", content: SISTEMA },
    { role: "user", content: `Trate o pedido ${caso.order_id} (cliente ${caso.customer_id}). Data de referência: 30/09/2026.` },
  ];
  let modeloIdx = 0;
  let tratativa: Tratativa | undefined;
  let cobrancas = 0;
  const vistas = new Set<string>();
  let corrigiuAlcada = false;
  let teveLimite = false;
  let corrigiuCorte = false;
  let corrigiuAtraso = false;

  for (let passo = 0; passo < MAX_PASSOS && !tratativa; passo++) {
    let msg: Msg | undefined;
    let esperou = false;
    while (!msg && modeloIdx < MODELOS.length) {
      try {
        msg = await chamarLLM(MODELOS[modeloIdx], mensagens, chave);
      } catch (e: any) {
        const st = e?.status;
        const espera = st === 429 ? segundosParaTentar(String(e?.message ?? "")) : null;
        if (st === 429) {
          teveLimite = true;
          if (!e?.leuCota) cotas.set(MODELOS[modeloIdx], Date.now() + (espera ?? 60) * 1000);
        }
        if (espera !== null && espera <= ESPERA_MAX_S && !esperou) {
          esperou = true;
          passos.push({ tipo: "aviso", texto: `Modelo ${MODELOS[modeloIdx]}: limite por minuto, aguardando ${Math.ceil(espera)}s.` });
          await dormir(Math.ceil(espera * 1000) + 300);
          continue;
        }
        // gpt-oss às vezes gera uma chamada malformada (ex.: ferramenta "commentary"); é falha passageira, vale repetir.
        if (st === 400 && String(e?.message ?? "").includes("tool_use_failed") && !esperou) {
          esperou = true;
          passos.push({ tipo: "aviso", texto: `Modelo ${MODELOS[modeloIdx]}: chamada de ferramenta malformada, tentando de novo.` });
          continue;
        }
        esperou = false;
        // Chave recusada vale para todos os modelos: não adianta tentar o próximo.
        if (st === 401 || st === 403) {
          console.error("[agente]", MODELOS[modeloIdx], String(e?.message ?? e).slice(0, 300));
          return porRegras(`A chave do Groq foi recusada (erro ${st}); esta tratativa veio do playbook. Confira a GROQ_API_KEY.`);
        }
        const motivo = st === 429 ? "limite gratuito atingido" : st === 404 || st === 400 ? "modelo recusou a chamada" : st ? `erro ${st}` : "sem resposta";
        passos.push({ tipo: "aviso", texto: `Modelo ${MODELOS[modeloIdx]}: ${motivo}. O próximo modelo assumiu.` });
        console.error("[agente]", MODELOS[modeloIdx], String(e?.message ?? e).slice(0, 300));
        modeloIdx++;
      }
    }
    if (!msg) {
      const r = porRegras(teveLimite ? AVISO_COTA : "A IA não respondeu agora; esta tratativa veio do playbook. Tente de novo em 1 minuto.");
      // O lote usa isso para esperar a cota em vez de aceitar o playbook.
      return teveLimite ? { ...r, cota_esgotada: true, espera_s: Math.max(5, esperaParaProximoCaso()) } : r;
    }

    const chamadas = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
    mensagens.push({ role: "assistant", content: msg.content ?? "", ...(chamadas.length ? { tool_calls: chamadas } : {}) });
    if (msg.content && String(msg.content).trim()) passos.push({ tipo: "pensamento", texto: String(msg.content).trim() });

    if (!chamadas.length) {
      if (++cobrancas > 2) break;
      mensagens.push({ role: "user", content: "Registre a decisão agora chamando registrar_tratativa." });
      continue;
    }
    const vistasAntes = new Set(vistas);
    for (const ch of chamadas) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(ch.function.arguments || "{}");
      } catch {
        args = {};
      }
      // A decisão só vale depois que o modelo leu as opções (custo e alçada) numa rodada anterior.
      if (ch.function.name === "registrar_tratativa" && !vistasAntes.has("calcular_opcoes")) {
        const resultado = { erro: "Antes de registrar, chame calcular_opcoes e decida com base no resultado." };
        passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado });
        mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(resultado) });
        continue;
      }
      vistas.add(ch.function.name);
      const { resultado, tratativa: t } = executar(ch.function.name, args);
      // A justificativa não pode dizer que o agente executa sozinho quando a alçada manda para uma pessoa.
      if (t && t.executor === "pessoa" && CONTRADIZ_ALCADA.test(t.justificativa) && !corrigiuAlcada) {
        corrigiuAlcada = true;
        const erro = {
          erro: `A tratativa NÃO foi registrada: o executor desta ação é "pessoa" (${t.motivo_alcada}), mas a justificativa diz que está na alçada do agente. Chame registrar_tratativa de novo com a justificativa corrigida.`,
        };
        passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado: erro });
        mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(erro) });
        continue;
      }
      // Pedido entregue com problema não está atrasado: a mensagem ao cliente não pode dizer isso.
      if (t && entregueComProblema(caso) && /atras/i.test(String(args.mensagem_cliente ?? "")) && !corrigiuAtraso) {
        corrigiuAtraso = true;
        const erro = {
          erro: `A tratativa NÃO foi registrada: o pedido foi entregue com problema (${caso.tipo_excecao}), não está atrasado. Reescreva a mensagem ao cliente falando do problema, sem dizer que está atrasado, e registre de novo.`,
        };
        passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado: erro });
        mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(erro) });
        continue;
      }
      // Texto que termina sem pontuação quase sempre foi cortado pelo limite de tokens.
      const cortado = t && [args.justificativa, args.mensagem_cliente].some((s) => typeof s === "string" && s.trim() && !/[.!?…)"”]$/.test(s.trim()));
      if (cortado && !corrigiuCorte) {
        corrigiuCorte = true;
        const erro = { erro: "A tratativa NÃO foi registrada: a justificativa ou a mensagem terminou no meio de uma frase. Registre de novo com frases completas e mais curtas." };
        passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado: erro });
        mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(erro) });
        continue;
      }
      passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado });
      mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(resultado) });
      if (t) tratativa = t;
    }
  }

  if (!tratativa) {
    const r = porRegras(teveLimite ? AVISO_COTA : "A IA não fechou a decisão a tempo; esta tratativa veio do playbook. Tente de novo em 1 minuto.");
    return teveLimite ? { ...r, cota_esgotada: true, espera_s: Math.max(5, esperaParaProximoCaso()) } : r;
  }
  return { modo: "ia", modelo: MODELOS[modeloIdx], passos, tratativa, duracao_ms: Date.now() - inicio, espera_s: esperaParaProximoCaso() };
}
