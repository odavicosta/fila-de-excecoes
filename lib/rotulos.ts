import type { CodigoAcao, TipoExcecao } from "./tipos";

export const TIPO: Record<TipoExcecao, string> = {
  atraso_entrega: "Atraso na entrega",
  extravio: "Extravio",
  rastreio_parado: "Rastreio parado",
  devolvido_transportadora: "Devolvido pela transportadora",
  avaria_transporte: "Avaria no transporte",
  vazamento_produto: "Vazamento",
  item_faltante: "Item faltante",
  falha_personalizacao: "Falha de personalização",
  pagamento_pendente: "Pagamento pendente",
  ruptura_pos_venda: "Ruptura pós-venda",
  endereco_divergente: "Endereço divergente",
};

export const STATUS: Record<string, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  aguardando_transportadora: "Aguardando transportadora",
  aguardando_cliente: "Aguardando cliente",
};

export const ACAO: Record<CodigoAcao, string> = {
  contato_proativo: "Avisar o cliente com nova previsão",
  cobrar_transportadora: "Cobrar a transportadora",
  tratar_como_extravio: "Tratar como extravio e reenviar",
  reenvio: "Reenviar o pedido",
  reenvio_item_faltante: "Enviar o item que faltou",
  reproduzir_personalizacao: "Produzir de novo em outra impressora",
  confirmar_endereco: "Confirmar o endereço com o cliente",
  enviar_link_pagamento: "Reenviar o link de pagamento",
  oferecer_substituto: "Oferecer substituto ou reembolso",
  reembolso: "Reembolsar",
  desculpas_cupom: "Pedir desculpas com cupom",
  lembrete_cliente: "Lembrar o cliente do que falta",
};

export const CAUSA: Record<string, string> = {
  causa_imp02: "Impressora IMP-02",
  causa_cd2_noite: "CD2, turno da noite",
  causa_lote: "Lote L2607-B",
  causa_rota_ne: "Rota Express no Nordeste",
  causa_carga_avaria: "Avaria Carga Norte",
  causa_promessa: "Prazo prometido errado",
  causa_ruptura: "Ruptura Kokeshi",
};

export const brl = (v: number, casas = 0) =>
  v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: casas, maximumFractionDigits: casas });

export const dec = (v: number, casas = 1) => v.toLocaleString("pt-BR", { maximumFractionDigits: casas });

export const num = (v: number) => v.toLocaleString("pt-BR");

/** 2 -> "dois", 7 -> "sete" (até dez; acima disso, o número). */
export const porExtenso = (n: number) =>
  ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez"][n] ?? String(n);

export const pct = (v: number) => `${Math.round(v * 100)}%`;

export const dataBR = (s: string | null | undefined) => {
  if (!s) return "—";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a.slice(2)}`;
};
