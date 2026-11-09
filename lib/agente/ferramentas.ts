import "server-only";
import { casoPorId, casos, casosDoCliente, resumo, transportadoras } from "../dados";
import { ACAO, TIPO } from "../rotulos";
import { acaoPadrao, alcada, custoAcao, montarTratativa } from "../regras";
import type { Caso, CodigoAcao, Tratativa } from "../tipos";

const P_CANCEL = (a: number) => (a <= 0 ? 0 : a <= 2 ? 0.04 : a <= 5 ? 0.1 : a <= 10 ? 0.22 : 0.4);
const NE = new Set(["BA", "PE", "PB", "CE", "RN", "AL", "SE", "PI", "MA"]);

export const CODIGOS_ACAO = Object.keys(ACAO) as CodigoAcao[];

/** Ações que fazem sentido para cada tipo de exceção (o agente escolhe dentro delas). */
const CANDIDATAS: Record<string, CodigoAcao[]> = {
  atraso_entrega: ["cobrar_transportadora", "contato_proativo", "tratar_como_extravio", "desculpas_cupom", "reembolso"],
  rastreio_parado: ["cobrar_transportadora", "contato_proativo", "tratar_como_extravio", "reembolso"],
  extravio: ["reenvio", "reembolso", "cobrar_transportadora", "contato_proativo"],
  devolvido_transportadora: ["confirmar_endereco", "reenvio", "reembolso"],
  endereco_divergente: ["confirmar_endereco", "lembrete_cliente"],
  avaria_transporte: ["reenvio", "reembolso", "cobrar_transportadora"],
  vazamento_produto: ["reenvio", "reembolso"],
  item_faltante: ["reenvio_item_faltante", "reembolso"],
  falha_personalizacao: ["reproduzir_personalizacao", "contato_proativo", "reembolso"],
  pagamento_pendente: ["enviar_link_pagamento", "lembrete_cliente"],
  ruptura_pos_venda: ["oferecer_substituto", "reembolso"],
};

export const definicoes = [
  {
    type: "function",
    function: {
      name: "consultar_pedido",
      description: "Dados do pedido com exceção: produto, prazos (prometido ao cliente e o correto pelo SLA), atraso em dias úteis, produção e separação.",
      parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_cliente",
      description: "Histórico do cliente: pedidos, receita acumulada, chance de recompra, valor futuro em risco e outras exceções abertas dele.",
      parameters: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_transportadora",
      description: "SLA e frete da transportadora na UF, desempenho dela nas exceções e alternativas para a mesma UF.",
      parameters: {
        type: "object",
        properties: { transportadora: { type: "string" }, uf: { type: "string" } },
        required: ["transportadora", "uf"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verificar_causa_sistemica",
      description: "Verifica se o pedido faz parte de um problema recorrente (máquina, turno, lote, transportadora, cálculo de prazo) e quantos outros casos iguais existem.",
      parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "calcular_opcoes",
      description: "Custo, alçada (quem pode executar) e perda esperada de cada ação possível para o pedido, mais a ação padrão do playbook.",
      parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "registrar_tratativa",
      description: "Registra a decisão final do caso. Chame uma única vez, no fim. Custo e alçada são calculados pelo sistema.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          acao: { type: "string", enum: CODIGOS_ACAO },
          acoes_complementares: { type: "array", items: { type: "string", enum: CODIGOS_ACAO } },
          justificativa: { type: "string", description: "2 a 4 frases com os números que sustentam a decisão." },
          mensagem_cliente: { type: "string", description: "Mensagem de WhatsApp para o cliente, em português, curta, sem prometer o que não depende da empresa." },
          chamado_interno: { type: "string", description: "Texto do chamado para transportadora, CD ou produção. Vazio se não houver." },
          alerta_processo: { type: "string", description: "Se o caso faz parte de um problema recorrente, o que precisa mudar no processo. Vazio se não houver." },
        },
        required: ["order_id", "acao", "justificativa", "mensagem_cliente"],
      },
    },
  },
] as const;

/** Tipos em que o pedido já chegou, mas com problema: não é atraso, é o cliente sem o produto certo. */
export const ENTREGUE_COM_PROBLEMA = new Set(["vazamento_produto", "avaria_transporte", "item_faltante"]);
export const entregueComProblema = (c: Caso) => c.entregue && ENTREGUE_COM_PROBLEMA.has(c.tipo_excecao);
const ddmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

function situacaoEntrega(c: Caso) {
  if (entregueComProblema(c))
    return `entregue com problema em ${ddmm(c.data_entrega)} (${TIPO[c.tipo_excecao].toLowerCase()}): o pedido chegou, não está atrasado; o cliente recebeu com defeito ou incompleto e espera a solução`;
  if (c.entregue) return `entregue com atraso em ${ddmm(c.data_entrega)}`;
  return "ainda não entregue";
}

function pedido(c: Caso) {
  const comProblema = entregueComProblema(c);
  return {
    situacao_entrega: situacaoEntrega(c),
    order_id: c.order_id,
    customer_id: c.customer_id,
    marca: c.marca,
    produto: `${c.sku} ${c.descricao_produto}`,
    valor: c.valor,
    qtd_itens: c.qtd_itens,
    brinde_no_pedido: c.brinde_no_pedido,
    tipo_excecao: TIPO[c.tipo_excecao],
    status: c.status,
    data_pedido: c.data_pedido,
    data_prometida_ao_cliente: c.data_prometida,
    data_prometida_correta_pelo_sla: c.data_prometida_correta,
    data_entrega: c.data_entrega,
    // Para quem recebeu com problema, o "atraso" é tempo sem solução, não entrega atrasada.
    ...(comProblema
      ? { dias_uteis_sem_solucao_desde_o_prazo_prometido: c.atraso_du }
      : { atraso_dias_uteis_vs_prometido: c.atraso_du, atraso_dias_uteis_vs_sla_contratado: c.atraso_sla_du }),
    transportadora: c.transportadora,
    destino: `${c.cidade}/${c.uf}`,
    producao: { maquina: c.maquina, turno: c.turno, cd: c.cd, lote: c.lote_produto },
    data_abertura_excecao: c.data_abertura_excecao,
    registro_duplicado_na_fila: c.duplicado,
    data_referencia: "2026-09-30",
  };
}

function cliente(customerId: string) {
  const lista = casosDoCliente(customerId);
  const c = lista[0];
  if (!c) return { erro: "cliente não encontrado" };
  return {
    customer_id: customerId,
    n_pedidos: c.n_pedidos,
    receita_acumulada: c.receita_acumulada,
    cliente_desde: c.data_primeiro_pedido,
    contatos_atendimento_12m: c.n_contatos_atendimento,
    cliente_alto_valor: c.cliente_vip,
    chance_recompra_12m: c.p_recompra,
    margem_futura_em_risco_se_mal_resolvido: c.perda_cliente,
    excecoes_abertas: lista.map((x) => ({ order_id: x.order_id, tipo: TIPO[x.tipo_excecao], status: x.status })),
  };
}

function transportadora(nome: string, uf: string) {
  const t = transportadoras.find((x) => x.transportadora.toLowerCase() === nome.toLowerCase() && x.uf_atendida === uf.toUpperCase());
  if (!t) return { erro: "transportadora/UF não encontrada" };
  const dela = casos.filter((c) => c.transportadora === t.transportadora);
  const regiao = NE.has(t.uf_atendida) ? "Nordeste" : "fora do Nordeste";
  const delaRegiao = dela.filter((c) => NE.has(c.uf) === NE.has(t.uf_atendida));
  const atrasos = delaRegiao.filter((c) => c.tipo_excecao === "atraso_entrega" || c.tipo_excecao === "rastreio_parado").length;
  const outras = casos.filter((c) => c.transportadora !== t.transportadora && NE.has(c.uf) === NE.has(t.uf_atendida));
  const atrasosOutras = outras.filter((c) => c.tipo_excecao === "atraso_entrega" || c.tipo_excecao === "rastreio_parado").length;
  return {
    transportadora: t.transportadora,
    uf: t.uf_atendida,
    sla_contratado_dias_uteis: t.sla_contratado_dias_uteis,
    frete_medio: t.custo_medio_frete,
    [`excecoes_dela_${regiao}`]: delaRegiao.length,
    [`parcela_atraso_ou_rastreio_parado_${regiao}`]: round(atrasos / Math.max(1, delaRegiao.length)),
    parcela_atraso_ou_rastreio_parado_outras_transportadoras: round(atrasosOutras / Math.max(1, outras.length)),
    parcela_avaria: round(dela.filter((c) => c.tipo_excecao === "avaria_transporte").length / Math.max(1, dela.length)),
    alternativas_mesma_uf: transportadoras
      .filter((x) => x.uf_atendida === t.uf_atendida && x.transportadora !== t.transportadora)
      .map((x) => ({ transportadora: x.transportadora, sla: x.sla_contratado_dias_uteis, frete: x.custo_medio_frete })),
  };
}

function causa(c: Caso) {
  const mapa: Record<string, string> = {
    causa_imp02: "imp02",
    causa_cd2_noite: "cd2_noite",
    causa_lote: "lote",
    causa_rota_ne: "rota_ne",
    causa_carga_avaria: "carga_avaria",
    causa_promessa: "promessa",
    causa_ruptura: "ruptura",
  };
  const achados = Object.entries(mapa)
    .filter(([k]) => (c as any)[k])
    .map(([k, id]) => {
      const a = resumo.achados.find((x) => x.id === id)!;
      return {
        problema: a.titulo,
        evidencia: a.evidencia,
        correcao_de_processo: a.acao,
        outros_casos_abertos_iguais: casos.filter((x) => (x as any)[k] && x.order_id !== c.order_id).length,
      };
    });
  return achados.length ? { faz_parte_de_problema_recorrente: true, achados } : { faz_parte_de_problema_recorrente: false };
}

const candidatas = (c: Caso): CodigoAcao[] => [
  ...new Set<CodigoAcao>(c.status === "aguardando_cliente" ? ["lembrete_cliente", ...CANDIDATAS[c.tipo_excecao]] : CANDIDATAS[c.tipo_excecao]),
];

export function opcoes(c: Caso) {
  const cand = candidatas(c);
  const padrao = acaoPadrao(c);
  return {
    chance_cancelamento_hoje: P_CANCEL(c.atraso_du),
    perda_esperada_se_resolver_hoje: c.perda_hoje,
    perda_esperada_se_esperar_5_dias_uteis: c.perda_5d,
    acao_padrao_do_playbook: { acao: padrao.acao, complementares: padrao.complementares },
    opcoes: cand.map((a) => {
      const custo = custoAcao(c, a);
      const { executor, motivo } = alcada(c, [a], custo);
      return { acao: a, descricao: ACAO[a], custo, executor, motivo_alcada: motivo };
    }),
    regra_de_alcada: "Agente executa sozinho ações sem custo e gastos até R$ 60. Reembolso, substituto, gastos acima de R$ 60 e qualquer gasto com cliente de alto valor vão para aprovação de uma pessoa.",
  };
}

export function executar(nome: string, args: Record<string, any>): { resultado: unknown; tratativa?: Tratativa } {
  try {
    switch (nome) {
      case "consultar_pedido": {
        const c = casoPorId(String(args.order_id ?? ""));
        return { resultado: c ? pedido(c) : { erro: "pedido não encontrado" } };
      }
      case "consultar_cliente":
        return { resultado: cliente(String(args.customer_id ?? "")) };
      case "consultar_transportadora":
        return { resultado: transportadora(String(args.transportadora ?? ""), String(args.uf ?? "")) };
      case "verificar_causa_sistemica": {
        const c = casoPorId(String(args.order_id ?? ""));
        return { resultado: c ? causa(c) : { erro: "pedido não encontrado" } };
      }
      case "calcular_opcoes": {
        const c = casoPorId(String(args.order_id ?? ""));
        return { resultado: c ? opcoes(c) : { erro: "pedido não encontrado" } };
      }
      case "registrar_tratativa": {
        const c = casoPorId(String(args.order_id ?? ""));
        if (!c) return { resultado: { erro: "pedido não encontrado" } };
        const acao = args.acao as CodigoAcao;
        const validas = candidatas(c);
        if (!validas.includes(acao))
          return { resultado: { erro: `ação "${acao}" não serve para este caso. A ação principal deve ser uma de: ${validas.join(", ")}` } };
        const compl = (Array.isArray(args.acoes_complementares) ? args.acoes_complementares : []).filter(
          (a: string) => CODIGOS_ACAO.includes(a as CodigoAcao) && a !== acao,
        ) as CodigoAcao[];
        const t = montarTratativa(c, acao, compl, {
          justificativa: args.justificativa,
          mensagem_cliente: args.mensagem_cliente,
          chamado_interno: args.chamado_interno,
          alerta_processo: args.alerta_processo || undefined,
        });
        return { resultado: { registrado: true, executor: t.executor, custo_estimado: t.custo_estimado }, tratativa: t };
      }
      default:
        return { resultado: { erro: `ferramenta desconhecida: ${nome}` } };
    }
  } catch (e) {
    return { resultado: { erro: String(e) } };
  }
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
