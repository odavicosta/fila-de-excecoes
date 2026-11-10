export type TipoExcecao =
  | "atraso_entrega"
  | "extravio"
  | "rastreio_parado"
  | "devolvido_transportadora"
  | "avaria_transporte"
  | "vazamento_produto"
  | "item_faltante"
  | "falha_personalizacao"
  | "pagamento_pendente"
  | "ruptura_pos_venda"
  | "endereco_divergente";

export interface Caso {
  order_id: string;
  customer_id: string;
  marca: string;
  data_pedido: string;
  valor: number;
  sku: string;
  descricao_produto: string;
  qtd_itens: number;
  brinde_no_pedido: boolean;
  tipo_excecao: TipoExcecao;
  status: string;
  transportadora: string;
  uf: string;
  cidade: string;
  data_prometida: string;
  data_prometida_correta: string;
  data_entrega: string | null;
  maquina: string | null;
  turno: string;
  cd: string;
  lote_produto: string;
  data_abertura_excecao: string;
  duplicado: boolean;
  sla_contratado_dias_uteis: number;
  custo_medio_frete: number;
  n_pedidos: number;
  receita_acumulada: number;
  data_primeiro_pedido: string;
  n_contatos_atendimento: number;
  atraso_du: number;
  atraso_sla_du: number;
  promessa_curta_du: number;
  entregue: boolean;
  p_cancel_hoje: number;
  perda_cliente: number;
  perda_hoje: number;
  perda_5d: number;
  custo_espera: number | null;
  score: number | null;
  custo_reenvio: number;
  custo_reembolso: number;
  cliente_vip: boolean;
  p_recompra: number;
  fila: "humana" | "automatica";
  prioridade: number | null;
  dia_previsto: number | null;
  causa_imp02: boolean;
  causa_cd2_noite: boolean;
  /** Fator de risco (não causa): item faltante em pedido com brinde de campanha. */
  risco_brinde: boolean;
  causa_lote: boolean;
  causa_rota_ne: boolean;
  causa_carga_avaria: boolean;
  causa_promessa: boolean;
  causa_ruptura: boolean;
}

export type CodigoAcao =
  | "contato_proativo"
  | "cobrar_transportadora"
  | "tratar_como_extravio"
  | "reenvio"
  | "reenvio_item_faltante"
  | "reproduzir_personalizacao"
  | "confirmar_endereco"
  | "enviar_link_pagamento"
  | "oferecer_substituto"
  | "reembolso"
  | "desculpas_cupom"
  | "lembrete_cliente";

export interface Tratativa {
  order_id: string;
  acao: CodigoAcao;
  acao_titulo: string;
  acoes_complementares: CodigoAcao[];
  executor: "agente" | "pessoa";
  motivo_alcada: string;
  custo_estimado: number;
  perda_evitada: number;
  justificativa: string;
  mensagem_cliente: string;
  chamado_interno: string;
  alerta_processo: string | null;
}

export interface PassoAgente {
  tipo: "ferramenta" | "pensamento" | "aviso";
  nome?: string;
  argumentos?: Record<string, unknown>;
  resultado?: unknown;
  texto?: string;
}

export interface RespostaAgente {
  modo: "ia" | "regras";
  modelo: string | null;
  passos: PassoAgente[];
  tratativa: Tratativa;
  aviso?: string;
  duracao_ms: number;
  /** Segundos até haver cota de IA para o próximo caso (0 = já pode). */
  espera_s?: number;
  /** A tratativa veio do playbook porque a cota de IA acabou. */
  cota_esgotada?: boolean;
  /** Qual limite acabou: o por minuto (espera curta) ou o diário (o lote para). */
  limite?: "minuto" | "dia";
  /** Tratativa gerada antes pela IA e salva no projeto (data ISO). */
  gerado_em?: string;
}

export interface Achado {
  id: string;
  titulo: string;
  area: string;
  evidencia: string;
  casos: number;
  acao: string;
  tipo: string;
  custo_mensal: number;
  graf: { label: string; unidade?: string; dados: { k: string; v: number }[] } | null;
}
