import type { Caso, CodigoAcao, Tratativa } from "./tipos";
import { ACAO, TIPO, brl, dataBR } from "./rotulos";

/** Alçada: até quanto o agente pode gastar sozinho num caso. ~P90 do custo de reenvio da base. */
export const LIMITE_AGENTE = 60;
export const CMV = 0.24;
export const CUPOM = 0.1;

const ACOES_SEM_CUSTO: CodigoAcao[] = [
  "contato_proativo",
  "cobrar_transportadora",
  "confirmar_endereco",
  "enviar_link_pagamento",
  "lembrete_cliente",
];

export function custoAcao(c: Caso, acao: CodigoAcao): number {
  switch (acao) {
    case "reenvio":
    case "tratar_como_extravio":
    case "reproduzir_personalizacao":
      return round(CMV * c.valor + c.custo_medio_frete);
    case "reenvio_item_faltante":
      return round((CMV * c.valor) / Math.max(1, c.qtd_itens) + c.custo_medio_frete);
    case "oferecer_substituto":
      return round(CMV * c.valor + c.custo_medio_frete);
    case "reembolso":
      return round(c.valor);
    case "desculpas_cupom":
      return round(CUPOM * c.valor);
    default:
      return 0;
  }
}

export function alcada(c: Caso, acoes: CodigoAcao[], custo: number): { executor: "agente" | "pessoa"; motivo: string } {
  if (acoes.includes("reembolso")) return { executor: "pessoa", motivo: "Reembolso sempre passa por uma pessoa." };
  if (acoes.includes("oferecer_substituto"))
    return { executor: "pessoa", motivo: "O cliente pode escolher reembolso, que sempre passa por uma pessoa." };
  if (acoes.every((a) => ACOES_SEM_CUSTO.includes(a))) return { executor: "agente", motivo: "Ação sem custo: o agente executa sozinho." };
  if (acoes.every((a) => a === "desculpas_cupom" || ACOES_SEM_CUSTO.includes(a)))
    return { executor: "agente", motivo: "Cupom de desculpas padrão (10%): o agente executa sozinho." };
  if (c.cliente_vip && custo > 0)
    return { executor: "pessoa", motivo: `Cliente com receita acumulada de ${brl(c.receita_acumulada)}: uma pessoa aprova.` };
  if (custo > LIMITE_AGENTE)
    return { executor: "pessoa", motivo: `Custo de ${brl(custo, 2)} acima do limite de ${brl(LIMITE_AGENTE)} do agente.` };
  return { executor: "agente", motivo: `Custo de ${brl(custo, 2)} dentro do limite de ${brl(LIMITE_AGENTE)}: o agente executa sozinho.` };
}

export function alertaProcesso(c: Caso): string | null {
  if (c.causa_imp02) return "Mais uma falha da IMP-02. Pedir manutenção da máquina e tirar ela da fila de impressão.";
  if (c.causa_lote) return "Mais um vazamento do lote L2607-B. Bloquear o lote no estoque e abrir não-conformidade com o fornecedor.";
  if (c.causa_cd2_noite)
    return c.brinde_no_pedido
      ? "Mais um item faltante do turno da noite do CD2 em pedido com brinde. Reforçar a conferência do brinde nesse turno."
      : "Mais um item faltante do turno da noite do CD2. Reforçar a conferência nesse turno.";
  if (c.causa_rota_ne) return "Mais um atraso da Rota Express no Nordeste. Somar ao dossiê para renegociar ou migrar o volume.";
  if (c.causa_carga_avaria) return "Mais uma avaria da Carga Norte. Pedir ressarcimento e somar ao dossiê de qualidade da transportadora.";
  if (c.causa_ruptura) return "Mais uma ruptura pós-venda da Kokeshi. Sincronizar o estoque do site com o WMS para este SKU.";
  if (c.causa_promessa)
    return "A transportadora está dentro do SLA contratado: o atraso vem da data prometida calculada em dias corridos no checkout.";
  return null;
}

/**
 * Quando um pedido não entregue passa a ser tratado como extravio, para atraso_entrega e rastreio_parado.
 * Mede contra o SLA contratado (o que a transportadora se comprometeu), não contra a data do checkout, que está errada.
 * Nenhuma das 809 entregas da base chegou mais de 10 dias úteis depois do SLA (p95 = 6, p99 = 9, máx. = 10).
 */
export const EXTRAVIO_DU_APOS_SLA = 10;
export const pareceExtravio = (c: Caso) => !c.entregue && c.atraso_sla_du > EXTRAVIO_DU_APOS_SLA;

/** Ação padrão por tipo de exceção. É o que o agente faria sem IA, e a referência que ele recebe. */
export function acaoPadrao(c: Caso): { acao: CodigoAcao; complementares: CodigoAcao[] } {
  if (c.status === "aguardando_cliente") return { acao: "lembrete_cliente", complementares: [] };
  switch (c.tipo_excecao) {
    case "atraso_entrega":
      if (c.entregue) return { acao: "desculpas_cupom", complementares: [] };
      if (pareceExtravio(c)) return { acao: "tratar_como_extravio", complementares: ["cobrar_transportadora", "contato_proativo"] };
      return { acao: "cobrar_transportadora", complementares: ["contato_proativo"] };
    case "rastreio_parado":
      if (pareceExtravio(c)) return { acao: "tratar_como_extravio", complementares: ["cobrar_transportadora", "contato_proativo"] };
      return { acao: "cobrar_transportadora", complementares: ["contato_proativo"] };
    case "extravio":
      return { acao: "reenvio", complementares: ["cobrar_transportadora", "contato_proativo"] };
    case "devolvido_transportadora":
      return { acao: "confirmar_endereco", complementares: ["reenvio"] };
    case "endereco_divergente":
      return { acao: "confirmar_endereco", complementares: [] };
    case "avaria_transporte":
      return { acao: "reenvio", complementares: ["cobrar_transportadora"] };
    case "vazamento_produto":
      return { acao: "reenvio", complementares: [] };
    case "item_faltante":
      return { acao: "reenvio_item_faltante", complementares: [] };
    case "falha_personalizacao":
      return { acao: "reproduzir_personalizacao", complementares: ["contato_proativo"] };
    case "pagamento_pendente":
      return { acao: "enviar_link_pagamento", complementares: [] };
    case "ruptura_pos_venda":
      return { acao: "oferecer_substituto", complementares: [] };
  }
}

function mensagemPadrao(c: Caso, acao: CodigoAcao): string {
  const produto = c.descricao_produto;
  const marca = c.marca;
  switch (acao) {
    case "desculpas_cupom":
      return `Oi! Aqui é do time ${marca}. Seu pedido ${c.order_id} chegou depois do prazo que prometemos, e isso não é o padrão que queremos para você. Como pedido de desculpas, deixamos um cupom de 10% para a sua próxima compra: DESCULPA10.`;
    case "lembrete_cliente":
      return `Oi! Aqui é do time ${marca}. Ainda precisamos da sua resposta para resolver o pedido ${c.order_id} (${produto}). É só responder esta mensagem que a gente segue daqui.`;
    case "enviar_link_pagamento":
      return `Oi! Seu pedido ${c.order_id} (${produto}) está reservado, mas o pagamento ainda não foi confirmado. Segue um novo link para concluir: [link]. Assim que o pagamento cair, a gente separa e envia.`;
    case "confirmar_endereco":
      return `Oi! A transportadora não conseguiu entregar o pedido ${c.order_id} no endereço cadastrado em ${c.cidade}/${c.uf}. Pode confirmar o endereço completo, com número e complemento? Assim que você responder, enviamos de novo sem custo.`;
    case "reenvio":
    case "tratar_como_extravio":
      return `Oi! Aqui é do time ${marca}. Vimos que o seu pedido ${c.order_id} (${produto}) teve um problema na entrega. Já enviamos outro, sem custo para você, e mandamos o novo rastreio assim que ele sair.`;
    case "reenvio_item_faltante":
      return `Oi! Aqui é do time ${marca}. Sentimos muito: faltou um item no seu pedido ${c.order_id}. Já estamos enviando o que faltou, sem custo, e você recebe o rastreio por aqui.`;
    case "reproduzir_personalizacao":
      return `Oi! Aqui é do time Gocase. Na conferência, vimos que a personalização do seu ${produto} não saiu perfeita. Já estamos produzindo de novo e te avisamos assim que ele for despachado.`;
    case "oferecer_substituto":
      return `Oi! Aqui é do time ${marca}. O ${produto} do seu pedido ${c.order_id} acabou no estoque depois da sua compra. Podemos enviar um produto equivalente agora ou fazer o reembolso integral. O que você prefere?`;
    case "reembolso":
      return `Oi! Aqui é do time ${marca}. Fizemos o reembolso integral de ${brl(c.valor, 2)} do pedido ${c.order_id}. O valor aparece em até 2 faturas no cartão ou 5 dias úteis no pix.`;
    case "cobrar_transportadora":
    case "contato_proativo":
      return `Oi! Aqui é do time ${marca}. Seu pedido ${c.order_id} está atrasado com a ${c.transportadora}. Já cobramos a transportadora e te mandamos a nova previsão de entrega até amanhã.`;
  }
}

function chamadoPadrao(c: Caso, acao: CodigoAcao, compl: CodigoAcao[]): string {
  const partes: string[] = [];
  const todas = [acao, ...compl];
  if (todas.includes("cobrar_transportadora"))
    partes.push(
      `Para ${c.transportadora}: pedido ${c.order_id}, destino ${c.cidade}/${c.uf}, prazo contratado de ${c.sla_contratado_dias_uteis} dias úteis vencido em ${dataBR(c.data_prometida_correta)}. Pedimos posição em 24h${
        c.tipo_excecao === "avaria_transporte" || c.tipo_excecao === "extravio" ? " e ressarcimento do valor da mercadoria" : ""
      }.`,
    );
  if (todas.includes("reenvio") || todas.includes("tratar_como_extravio"))
    partes.push(`Para o CD: separar novamente o ${c.sku} (${c.descricao_produto}) para o pedido ${c.order_id}${c.causa_lote ? ", de um lote diferente do L2607-B" : ""}.`);
  if (acao === "reenvio_item_faltante")
    partes.push(`Para o CD: enviar o item que faltou no pedido ${c.order_id}${c.brinde_no_pedido ? " e conferir se o brinde da campanha foi junto" : ""}.`);
  if (acao === "reproduzir_personalizacao")
    partes.push(`Para a produção: reimprimir o ${c.sku} do pedido ${c.order_id} ${c.maquina === "IMP-02" ? "em outra impressora (não na IMP-02)" : "com prioridade"} e despachar no mesmo dia.`);
  return partes.join("\n") || "Sem chamado interno.";
}

export function montarTratativa(
  c: Caso,
  acao: CodigoAcao,
  complementares: CodigoAcao[],
  textos?: { justificativa?: string; mensagem_cliente?: string; chamado_interno?: string; alerta_processo?: string | null },
): Tratativa {
  const todas = [acao, ...complementares];
  const custo = round(todas.reduce((s, a) => s + custoAcao(c, a), 0));
  const { executor, motivo } = alcada(c, todas, custo);
  const alerta = textos?.alerta_processo === undefined ? alertaProcesso(c) : textos.alerta_processo || alertaProcesso(c);
  return {
    order_id: c.order_id,
    acao,
    acao_titulo: ACAO[acao],
    acoes_complementares: complementares,
    executor,
    motivo_alcada: motivo,
    custo_estimado: custo,
    perda_evitada: round(c.perda_5d),
    justificativa: textos?.justificativa?.trim() || justificativaPadrao(c, acao, custo),
    mensagem_cliente: textos?.mensagem_cliente?.trim() || mensagemPadrao(c, acao),
    chamado_interno: textos?.chamado_interno?.trim() || chamadoPadrao(c, acao, complementares),
    alerta_processo: alerta,
  };
}

function justificativaPadrao(c: Caso, acao: CodigoAcao, custo: number) {
  const dias = `${c.atraso_du} ${c.atraso_du === 1 ? "dia útil" : "dias úteis"}`;
  const chegouComProblema = c.entregue && ["vazamento_produto", "avaria_transporte", "item_faltante"].includes(c.tipo_excecao);
  const partes = [
    chegouComProblema
      ? `${TIPO[c.tipo_excecao]} em pedido já entregue, ${dias} sem solução desde o prazo prometido: ${Math.round(c.p_cancel_hoje * 100)}% de chance de cancelamento.`
      : `${TIPO[c.tipo_excecao]} com ${dias} de atraso sobre o prazo prometido: ${Math.round(c.p_cancel_hoje * 100)}% de chance de cancelamento.`,
  ];
  if (acao === "reenvio" || acao === "tratar_como_extravio")
    partes.push(`Reenviar custa ${brl(custo, 2)} (CMV + frete), contra ${brl(c.valor, 2)} de um reembolso.`);
  if (c.cliente_vip) partes.push(`Cliente com ${c.n_pedidos} pedidos e ${brl(c.receita_acumulada)} de receita: 70% de chance de recompra, que cai à metade se a exceção for mal resolvida.`);
  partes.push(
    c.perda_5d > c.perda_hoje + 1
      ? `Perda esperada de ${brl(c.perda_hoje)} hoje, que sobe para ${brl(c.perda_5d)} se o caso esperar mais uma semana.`
      : `Perda esperada de ${brl(c.perda_hoje)}, já no teto da tabela de cancelamento: cada dia a mais é chance de o cliente desistir antes do contato.`,
  );
  return partes.join(" ");
}

export const tratativaPorRegras = (c: Caso): Tratativa => {
  const { acao, complementares } = acaoPadrao(c);
  return montarTratativa(c, acao, complementares);
};

function round(v: number) {
  return Math.round(v * 100) / 100;
}
