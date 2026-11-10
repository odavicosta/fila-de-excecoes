import "server-only";
import { casoPorId } from "../dados";
import { tratativaPorRegras } from "../regras";
import type { PassoAgente, RespostaAgente, Tratativa } from "../tipos";
import { definicoes, entregueComProblema, executar } from "./ferramentas";

const URL = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";
// Modelos do Groq com tool calling disponíveis no plano gratuito. Cada um tem cota própria:
// 8 mil tokens por minuto e 200 mil tokens por dia (janela móvel de 24 h).
// O 20b vem primeiro: nos testes ele fechou todos os casos em 5-9 s; o 120b muitas vezes respondia
// a decisão em texto ou com chamada malformada em vez de registrar.
const MODELOS = (process.env.GROQ_MODELS || "openai/gpt-oss-20b,openai/gpt-oss-120b,qwen/qwen3.8-27b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_PASSOS = 5;
/** Se o limite por minuto pede para esperar no máximo isso, espera e tenta o mesmo modelo de novo em vez de trocar. */
const ESPERA_MAX_S = 6;

const CONTRADIZ_ALCADA =
  /(dentro d[ao] (limite|alçada)|alçada do agente|(execut[áa]vel|executad[ao]|executa[r]?)\s+(pelo|por|o)?\s*agente|agente\s+(executa|pode executar|resolve)|sozinho)/i;

const JA_FEITO = /\bj[áa] (enviamos|reenviamos|fizemos|reembolsamos|produzimos|estamos (enviando|reenviando|produzindo|reembolsando))/i;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lê o "Please try again in 3.95s" / "in 10m0.48s" / "in 1h2m3s" da mensagem de limite do Groq. */
function segundosParaTentar(msg: string): number | null {
  const m = /try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(msg);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 1000;
}

/** "7.66s", "1m2.5s", "120ms" -> segundos */
function lerDuracao(s: string | null): number | null {
  if (!s) return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 1000;
}

/** Texto curto para a espera: "40 segundos", "12 minutos", "3 horas". */
export function tempoPorExtenso(s: number): string {
  if (s < 60) return `${Math.max(1, Math.ceil(s))} segundos`;
  if (s < 3600) {
    const m = Math.ceil(s / 60);
    return m === 1 ? "1 minuto" : `${m} minutos`;
  }
  const h = Math.round(s / 3600);
  return h === 1 ? "1 hora" : `${h} horas`;
}

// Quando cada modelo volta a ter cota para um caso inteiro. "diario" marca o limite de tokens (ou requisições) por dia,
// que não se resolve esperando alguns segundos. Vale para a instância do servidor; se ela não souber de algo, o 429 corrige.
const TOKENS_POR_CASO = 5000;
const cotas = new Map<string, { livreEm: number; diario: boolean }>();

/** O limite por minuto repõe de forma contínua: com R tokens restantes de L, faltam (5000 - R) / L minutos. */
function registrarCotaMinuto(modelo: string, h: Headers) {
  const atual = cotas.get(modelo);
  if (atual?.diario && atual.livreEm > Date.now()) return; // o limite diário manda
  const restantes = Number(h.get("x-ratelimit-remaining-tokens"));
  const limite = Number(h.get("x-ratelimit-limit-tokens"));
  if (h.has("x-ratelimit-remaining-tokens") && Number.isFinite(restantes) && limite > 0) {
    cotas.set(modelo, { livreEm: Date.now() + (Math.max(0, TOKENS_POR_CASO - restantes) / limite) * 60_000, diario: false });
    return;
  }
  const reset = lerDuracao(h.get("x-ratelimit-reset-tokens"));
  if (reset !== null) cotas.set(modelo, { livreEm: Date.now() + reset * 1000, diario: false });
}

/** Guarda o que o 429 disse: se é o limite por dia ou por minuto, e quanto falta. */
function registrarLimite(modelo: string, msg: string) {
  const diario = /per day|\(TPD\)|\(RPD\)/i.test(msg);
  const espera = segundosParaTentar(msg);
  if (diario) cotas.set(modelo, { livreEm: Date.now() + (espera ?? 3600) * 1000, diario: true });
  else if (espera !== null) cotas.set(modelo, { livreEm: Date.now() + espera * 1000, diario: false });
  return { diario, espera };
}

const bloqueadoNoDia = (m: string) => {
  const c = cotas.get(m);
  return !!c?.diario && c.livreEm > Date.now();
};

/** Segundos até algum modelo ter cota para um caso inteiro (0 = pode rodar já) e se a espera é do limite diário. */
export function situacaoDaCota(): { espera_s: number; diario: boolean } {
  let menor = Infinity;
  let diario = true;
  for (const m of MODELOS) {
    const c = cotas.get(m);
    if (!c || c.livreEm <= Date.now()) return { espera_s: 0, diario: false };
    if (c.livreEm < menor) {
      menor = c.livreEm;
      diario = c.diario;
    }
  }
  return { espera_s: Math.ceil((menor - Date.now()) / 1000), diario };
}

function avisoDeCota(espera: number, diario: boolean) {
  return diario
    ? `A cota diária gratuita de IA acabou; esta tratativa veio do playbook. A IA volta em cerca de ${tempoPorExtenso(espera)}.`
    : `A cota gratuita de IA acabou por agora; esta tratativa veio do playbook. Tente de novo em ${tempoPorExtenso(espera)}.`;
}

const SISTEMA = `Você é o agente de tratativas do time de Operações da Gocase e da GoBeauté.
Sua tarefa: investigar UM pedido com exceção e registrar a melhor tratativa, que será executada de verdade.

Como trabalhar:
1. Chame investigar_caso com o order_id. Ela traz pedido, cliente, transportadora, problema recorrente e as opções com custo e alçada.
2. Decida com base nesses números, nunca invente valores. Reenviar custa CMV (24% do valor) + frete; reembolsar custa o valor pago e aumenta a chance de perder o cliente.
3. Termine chamando registrar_tratativa uma única vez. A ação principal deve estar entre as opções. Siga a ação padrão do playbook, a não ser que os dados mostrem um motivo claro para outra; se mudar, explique na justificativa.
4. Na justificativa, não diga quem executa nem fale de alçada ou limite: o sistema calcula isso e mostra à parte. Fale do problema, dos números e do porquê da ação.

Regras de negócio:
- Probabilidade de cancelamento por dias úteis de atraso sobre o prazo prometido: 1-2: 4%, 3-5: 10%, 6-10: 22%, >10: 40%.
- Cliente com receita acumulada acima de R$ 1.500 recompra em 70% dos casos, os demais em 28%. Exceção mal resolvida corta isso pela metade.
- Falha de personalização exige produzir de novo; nunca na impressora IMP-02 se ela for a causa.
- Se o caso faz parte de um problema recorrente, preencha alerta_processo com o que precisa mudar.
- Mensagem ao cliente: português do Brasil, tom humano, até 3 frases, sem prometer datas que dependem da transportadora. Comece com "Oi! Aqui é do time <marca do pedido>.", cite o número do pedido e descreva o problema real dele (o tipo_excecao: vazamento, item faltante etc., não "atraso" se não for atraso). Não use o nome do cliente (não temos).
- Se pedido.situacao_entrega diz "entregue com problema", o pedido CHEGOU: na mensagem e na justificativa fale do problema (vazamento, avaria, item faltante) e dos dias úteis sem solução. Nunca diga que o pedido está atrasado ou com atraso. Se diz "ainda não entregue", nunca diga que o pedido chegou.
- Se o executor da ação escolhida é "pessoa", a mensagem só sai depois da aprovação: escreva no futuro ("vamos enviar", "vamos fazer o reembolso"), nunca "já enviamos" ou "já fizemos".
- Se o status é aguardando_cliente, a base não diz o que falta. Peça ao cliente que responda à última mensagem do atendimento; não invente o que falta (endereço, foto, documento etc.).
- Se pedido.produto_personalizado é true (Gocase), refazer o pedido é nova produção com a mesma personalização, nunca "separar de novo" no CD.
- chamado_interno: deixe vazio, a não ser que precise de algo além do chamado padrão; o sistema gera o chamado para transportadora, CD ou produção com pedido, SKU, lote e prazo.
- Seja breve: nada de texto fora das chamadas de ferramenta.`;

type Msg = Record<string, any>;
type ErroLLM = Error & { status?: number };

async function chamarLLM(modelo: string, mensagens: Msg[], chave: string) {
  const corpo: Record<string, unknown> = {
    model: modelo,
    messages: mensagens,
    tools: definicoes,
    // Todo turno deste agente é uma chamada de ferramenta; sem isso o gpt-oss às vezes responde a decisão em texto
    // e gasta uma rodada extra (e cota) só para ser cobrado a registrar.
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
    registrarCotaMinuto(modelo, r.headers);
    if (!r.ok) {
      const txt = await r.text();
      const e: ErroLLM = new Error(`HTTP ${r.status}: ${txt.slice(0, 400)}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    const escolha = j.choices?.[0];
    if (escolha && !escolha.message?.tool_calls?.length)
      console.error("[agente]", modelo, "resposta sem ferramenta:", escolha.finish_reason, String(escolha.message?.content ?? "").slice(0, 200));
    return { msg: escolha?.message as Msg, tokens: Number(j.usage?.total_tokens) || 0 };
  } finally {
    clearTimeout(t);
  }
}

/** Investigação determinística: usada quando a IA não está disponível, para o trace continuar mostrando o que foi consultado. */
function investigacaoPorRegras(orderId: string): PassoAgente[] {
  const argumentos = { order_id: orderId };
  return [{ tipo: "ferramenta", nome: "investigar_caso", argumentos, resultado: executar("investigar_caso", argumentos).resultado }];
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
  /** Playbook porque a cota acabou: o lote usa limite e espera_s para decidir se espera ou para. */
  const semCota = (): RespostaAgente => {
    const { espera_s, diario } = situacaoDaCota();
    const espera = Math.max(5, espera_s);
    return { ...porRegras(avisoDeCota(espera, diario)), cota_esgotada: true, limite: diario ? "dia" : "minuto", espera_s: espera };
  };

  if (!chave) return porRegras("Sem chave de IA configurada (GROQ_API_KEY); esta tratativa veio do playbook.");

  const mensagens: Msg[] = [
    { role: "system", content: SISTEMA },
    { role: "user", content: `Trate o pedido ${caso.order_id}. Data de referência: 30/09/2026.` },
  ];
  let modeloIdx = 0;
  let tratativa: Tratativa | undefined;
  let cobrancas = 0;
  const vistas = new Set<string>();
  let corrigiuAlcada = false;
  let teveLimite = false;
  let corrigiuCorte = false;
  let corrigiuAtraso = false;
  let corrigiuFuturo = false;
  /** Tokens que o Groq contou por modelo neste caso (entrada + saída). */
  const tokens: Record<string, number> = {};

  for (let passo = 0; passo < MAX_PASSOS && !tratativa; passo++) {
    let msg: Msg | undefined;
    let esperou = false;
    while (!msg && modeloIdx < MODELOS.length) {
      const modelo = MODELOS[modeloIdx];
      // Modelo sem cota no dia: pula sem gastar uma requisição.
      if (bloqueadoNoDia(modelo)) {
        teveLimite = true;
        passos.push({ tipo: "aviso", texto: `Modelo ${modelo}: cota diária esgotada. O próximo modelo assumiu.` });
        modeloIdx++;
        continue;
      }
      try {
        const r = await chamarLLM(modelo, mensagens, chave);
        msg = r.msg;
        tokens[modelo] = (tokens[modelo] ?? 0) + r.tokens;
      } catch (e) {
        const err = e as ErroLLM;
        const st = err.status;
        const texto = String(err.message ?? err);
        if (st === 429) {
          teveLimite = true;
          const { diario, espera } = registrarLimite(modelo, texto);
          if (!diario && espera !== null && espera <= ESPERA_MAX_S && !esperou) {
            esperou = true;
            passos.push({ tipo: "aviso", texto: `Modelo ${modelo}: limite por minuto, aguardando ${Math.ceil(espera)}s.` });
            await dormir(Math.ceil(espera * 1000) + 300);
            continue;
          }
          esperou = false;
          passos.push({ tipo: "aviso", texto: `Modelo ${modelo}: ${diario ? "cota diária esgotada" : "limite por minuto atingido"}. O próximo modelo assumiu.` });
          console.error("[agente]", modelo, texto.slice(0, 300));
          modeloIdx++;
          continue;
        }
        // gpt-oss às vezes gera uma chamada malformada (ex.: ferramenta "commentary"); é falha passageira, vale repetir.
        if (st === 400 && texto.includes("tool_use_failed") && !esperou) {
          esperou = true;
          passos.push({ tipo: "aviso", texto: `Modelo ${modelo}: chamada de ferramenta malformada, tentando de novo.` });
          continue;
        }
        esperou = false;
        // Chave recusada vale para todos os modelos: não adianta tentar o próximo.
        if (st === 401 || st === 403) {
          console.error("[agente]", modelo, texto.slice(0, 300));
          return porRegras(`A chave do Groq foi recusada (erro ${st}); esta tratativa veio do playbook. Confira a GROQ_API_KEY.`);
        }
        const motivo = st === 404 || st === 400 ? "modelo recusou a chamada" : st ? `erro ${st}` : "sem resposta";
        passos.push({ tipo: "aviso", texto: `Modelo ${modelo}: ${motivo}. O próximo modelo assumiu.` });
        console.error("[agente]", modelo, texto.slice(0, 300));
        modeloIdx++;
      }
    }
    if (!msg) return teveLimite ? semCota() : porRegras("A IA não respondeu agora; esta tratativa veio do playbook. Tente de novo em 1 minuto.");

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
      const recusar = (erro: string) => {
        passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado: { erro } });
        mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify({ erro }) });
      };
      // A decisão só vale depois que o modelo leu a investigação (opções, custo e alçada) numa rodada anterior.
      if (ch.function.name === "registrar_tratativa" && !vistasAntes.has("investigar_caso")) {
        recusar("Antes de registrar, chame investigar_caso e decida com base no resultado.");
        continue;
      }
      vistas.add(ch.function.name);
      let { resultado, tratativa: t } = executar(ch.function.name, args);
      // Mensagem que diz "já enviamos" num caso que depende de aprovação, ou "atrasado" num pedido entregue com problema:
      // na primeira vez volta para o modelo corrigir (travas abaixo); se ele insistir, fica a mensagem do playbook.
      const msg = String(args.mensagem_cliente ?? "");
      const jaFeito = !!t && t.executor === "pessoa" && JA_FEITO.test(msg);
      const atrasado = !!t && entregueComProblema(caso) && /atras/i.test(msg);
      if ((jaFeito || atrasado) && (!jaFeito || corrigiuFuturo) && (!atrasado || corrigiuAtraso))
        ({ resultado, tratativa: t } = executar(ch.function.name, { ...args, mensagem_cliente: "" }));
      // A justificativa não pode dizer que o agente executa sozinho quando a alçada manda para uma pessoa.
      if (t && t.executor === "pessoa" && CONTRADIZ_ALCADA.test(t.justificativa) && !corrigiuAlcada) {
        corrigiuAlcada = true;
        recusar(
          `A tratativa NÃO foi registrada: o executor desta ação é "pessoa" (${t.motivo_alcada}), mas a justificativa diz que está na alçada do agente. Chame registrar_tratativa de novo com a justificativa corrigida.`,
        );
        continue;
      }
      // Pedido entregue com problema não está atrasado: a mensagem ao cliente não pode dizer isso.
      if (t && entregueComProblema(caso) && /atras/i.test(String(args.mensagem_cliente ?? "")) && !corrigiuAtraso) {
        corrigiuAtraso = true;
        recusar(
          `A tratativa NÃO foi registrada: o pedido foi entregue com problema (${caso.tipo_excecao}), não está atrasado. Reescreva a mensagem ao cliente falando do problema, sem dizer que está atrasado, e registre de novo.`,
        );
        continue;
      }
      // Ação que depende de aprovação ainda não aconteceu: a mensagem não pode dizer que já foi feita.
      if (t && t.executor === "pessoa" && JA_FEITO.test(String(args.mensagem_cliente ?? "")) && !corrigiuFuturo) {
        corrigiuFuturo = true;
        recusar(
          `A tratativa NÃO foi registrada: a ação depende de aprovação de uma pessoa (${t.motivo_alcada}), então ainda não foi feita. Reescreva a mensagem no futuro ("vamos enviar"), sem dizer que já foi feita, e registre de novo.`,
        );
        continue;
      }
      // Texto que termina sem pontuação quase sempre foi cortado pelo limite de tokens.
      const cortado = t && [args.justificativa, args.mensagem_cliente].some((s) => typeof s === "string" && s.trim() && !/[.!?…)"”]$/.test(s.trim()));
      if (cortado && !corrigiuCorte) {
        corrigiuCorte = true;
        recusar("A tratativa NÃO foi registrada: a justificativa ou a mensagem terminou no meio de uma frase. Registre de novo com frases completas e mais curtas.");
        continue;
      }
      passos.push({ tipo: "ferramenta", nome: ch.function.name, argumentos: args, resultado });
      mensagens.push({ role: "tool", tool_call_id: ch.id, content: JSON.stringify(resultado) });
      if (t) tratativa = t;
    }
  }

  if (!tratativa) return teveLimite ? semCota() : porRegras("A IA não fechou a decisão a tempo; esta tratativa veio do playbook. Tente de novo em 1 minuto.");
  return { modo: "ia", modelo: MODELOS[modeloIdx], passos, tratativa, duracao_ms: Date.now() - inicio, espera_s: situacaoDaCota().espera_s, tokens };
}
