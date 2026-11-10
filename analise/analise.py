"""Análise do Problema 2 (Operações) — gera os dados que o app usa.

Uso: python3 -I analise.py <pasta_dados_operacoes> <pasta_saida>
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

REF = np.datetime64("2026-09-30")
HOL = np.array(["2026-09-07", "2026-10-12"], dtype="datetime64[D]")
CAPACIDADE = 150
MIN_TRATATIVA = 12
CMV = 0.24
MARGEM = 1 - CMV
CUSTO_CONTATO = 9.0
NE = {"BA", "PE", "PB", "CE", "RN", "AL", "SE", "PI", "MA"}
ONE = np.timedelta64(1, "D")


def dd(s):
    return np.array(pd.to_datetime(s).values, dtype="datetime64[D]")


def p_cancel(a):
    a = np.asarray(a)
    return np.select([a <= 0, a <= 2, a <= 5, a <= 10], [0.0, 0.04, 0.10, 0.22], 0.40)


raw = pd.read_csv(SRC / "pedidos_excecao.csv")
cli = pd.read_csv(SRC / "clientes.csv")
tra = pd.read_csv(SRC / "transportadoras.csv")

# ---------------------------------------------------------------- limpeza
n_linhas = len(raw)
dup_ids = raw.loc[raw.order_id.duplicated(keep=False), "order_id"].unique()
ordem_status = {"em_analise": 0, "aguardando_transportadora": 1, "aguardando_cliente": 2, "aberta": 3}
raw["_o"] = raw.status.map(ordem_status)
df = raw.sort_values(["order_id", "_o"]).drop_duplicates("order_id").drop(columns="_o").copy()
df["duplicado"] = df.order_id.isin(dup_ids)

df = df.merge(tra, left_on=["transportadora", "uf"], right_on=["transportadora", "uf_atendida"], how="left")
df = df.merge(cli, on="customer_id", how="left")
assert df.sla_contratado_dias_uteis.notna().all()

# ---------------------------------------------------------------- prazos
dp = dd(df.data_pedido)
dia1 = np.busday_offset(dp, 1, roll="backward", holidays=HOL)  # 1º dia útil após o pedido = separação (sáb/dom/feriado contam a partir do dia útil anterior)
prom_correta = np.busday_offset(dia1, df.sla_contratado_dias_uteis.values.astype(int), holidays=HOL)
prom_sis = dd(df.data_prometida)
df["data_prometida_correta"] = pd.to_datetime(prom_correta).strftime("%Y-%m-%d")
df["promessa_curta_du"] = np.busday_count(prom_sis, prom_correta, holidays=HOL)
formula_corridos = float(np.mean(prom_sis == dp + (1 + df.sla_contratado_dias_uteis.values).astype("timedelta64[D]")))

entregue = df.data_entrega.notna().values
dent = dd(df.data_entrega.fillna("2026-09-30"))
fim = np.where(entregue, dent, REF)
df["entregue"] = entregue
# Tipos em que o cliente ainda NÃO recebeu o que comprou em perfeito estado (não entregue, ou entregue com
# avaria/vazamento/item faltante): o atraso continua crescendo até alguém resolver.
# Só o atraso que já foi entregue fica congelado na data de entrega.
df["atraso_cresce"] = ~((df.tipo_excecao == "atraso_entrega") & df.entregue)
fim = np.where(df.atraso_cresce.values, REF, fim)
# atraso percebido pelo cliente (em relação ao que foi prometido a ele), em dias úteis
df["atraso_du"] = np.busday_count(prom_sis + ONE, fim + ONE, holidays=HOL).clip(min=0)
# atraso da ENTREGA em relação ao SLA contratado de verdade (para medir a transportadora)
fim_ent = np.where(entregue, dent, REF)
df["atraso_sla_du"] = np.busday_count(prom_correta + ONE, fim_ent + ONE, holidays=HOL)
df["dentro_sla"] = fim_ent <= prom_correta

# ---------------------------------------------------------------- valor do cliente
anos = ((REF - dd(df.data_primeiro_pedido)) / np.timedelta64(1, "D") / 365).clip(min=1.0)
df["receita_anual"] = df.receita_acumulada / anos
df["p_recompra"] = np.where(df.receita_acumulada > 1500, 0.70, 0.28)
# exceção mal resolvida reduz a recompra pela metade -> perde metade da margem futura esperada
df["perda_cliente"] = 0.5 * df.p_recompra * df.receita_anual * MARGEM
df["cliente_vip"] = df.receita_acumulada > 1500

df["custo_reenvio"] = CMV * df.valor + df.custo_medio_frete
df["custo_reembolso"] = df.valor


def atraso_em(t):
    """atraso (du) se o caso só for resolvido daqui a t dias úteis"""
    a = df.atraso_du.values.copy()
    grow = df.atraso_cresce.values
    if t > 0:
        alvo = np.busday_offset(REF, t, roll="forward", holidays=HOL)
        a2 = np.busday_count(prom_sis + ONE, alvo + ONE, holidays=HOL).clip(min=0)
        a = np.where(grow, a2, a)
    return a


# O que se perde se o cliente desiste: o reembolso do valor pago, mais o valor futuro dele. No pagamento pendente não
# há o que reembolsar: perde-se a venda que não se concluiu, ou seja, a margem dela (76% do valor) mais o valor futuro.
df["valor_em_risco"] = np.where(df.tipo_excecao == "pagamento_pendente", MARGEM * df.valor, df.valor)


def perda(t):
    return p_cancel(atraso_em(t)) * (df.valor_em_risco.values + df.perda_cliente.values)


df["p_cancel_hoje"] = p_cancel(df.atraso_du)
df["perda_hoje"] = perda(0)
df["perda_5d"] = perda(5)

# ---------------------------------------------------------------- filas
# Automático (o agente executa sem gastar tratativa humana):
#  - aguardando_cliente: lembrete com o que falta
#  - pagamento_pendente: reenvio do link de pagamento
#  - atraso já entregue: pedido de desculpas + cupom
#  - duplicados: fundidos
auto = (
    (df.status == "aguardando_cliente")
    | (df.tipo_excecao == "pagamento_pendente")
    | ((df.tipo_excecao == "atraso_entrega") & df.entregue)
)
df["fila"] = np.where(auto, "automatica", "humana")

# ---------------------------------------------------------------- causas raiz (flags)
df["causa_imp02"] = (df.maquina == "IMP-02") & (df.tipo_excecao == "falha_personalizacao")
df["causa_cd2_noite"] = (df.cd == "CD2") & (df.turno == "noite") & (df.tipo_excecao == "item_faltante")
df["causa_lote"] = (df.lote_produto == "L2607-B") & (df.tipo_excecao == "vazamento_produto")
df["causa_rota_ne"] = (df.transportadora == "Rota Express") & df.uf.isin(NE) & df.tipo_excecao.isin(["atraso_entrega", "rastreio_parado"])
df["causa_carga_avaria"] = (df.transportadora == "Carga Norte") & (df.tipo_excecao == "avaria_transporte")
df["causa_promessa"] = (df.tipo_excecao == "atraso_entrega") & df.dentro_sla
df["causa_ruptura"] = (df.tipo_excecao == "ruptura_pos_venda") & (df.marca == "Kokeshi")
# Fator de risco, não causa: pedido com brinde tem mais item faltante em todos os turnos. Fica fora da contagem
# de casos com causa recorrente (colunas causa_*), mas o agente avisa quando o caso cai nele.
df["risco_brinde"] = (df.tipo_excecao == "item_faltante") & df.brinde_no_pedido

# ---------------------------------------------------------------- simulação de políticas
hum = df[df.fila == "humana"].copy()
H = int(np.ceil(len(hum) / CAPACIDADE))
L = np.vstack([perda(t)[(df.fila == "humana").values] for t in range(H + 1)])  # perda por dia de tratamento


def simula(ordem):
    dia = np.empty(len(hum), dtype=int)
    dia[ordem] = np.arange(len(hum)) // CAPACIDADE
    return float(L[dia, np.arange(len(hum))].sum()), dia


pos = {k: i for i, k in enumerate(hum.index)}
pol = {}
pol["fifo"] = np.argsort(hum.data_abertura_excecao.values, kind="stable")
pol["maior_valor"] = np.argsort(-hum.valor.values, kind="stable")
pol["maior_atraso"] = np.argsort(-hum.atraso_du.values, kind="stable")
pol["perda_hoje"] = np.argsort(-hum.perda_hoje.values, kind="stable")
pol["perda_5d"] = np.argsort(-hum.perda_5d.values, kind="stable")
# custo de esperar: quanto a perda cresce se o caso esperar 1 ciclo, + perda atual como desempate
hum["custo_espera"] = hum.perda_5d - hum.perda_hoje
pol["custo_espera"] = np.lexsort((-hum.perda_hoje.values, -hum.custo_espera.values))
# híbrido: custo de esperar + metade do risco que o caso já carrega. Fica a ~R$5 mil do ótimo do modelo,
# mas não deixa quem já está no teto de cancelamento (>10 du) para o fim da fila.
ALFA = 0.5
hum["score"] = hum.custo_espera + ALFA * hum.perda_hoje
pol["urgencia_risco"] = np.argsort(-hum.score.values, kind="stable")
res = {k: simula(v)[0] for k, v in pol.items()}
melhor = "urgencia_risco"
teto = hum.atraso_du.values > 10
dia_teto = {k: round(float(simula(v)[1][teto].mean()), 2) for k, v in pol.items()}
_, dia_melhor = simula(pol[melhor])
_, dia_fifo = simula(pol["fifo"])

hum["prioridade"] = 0
hum.loc[hum.index[pol[melhor]], "prioridade"] = np.arange(1, len(hum) + 1)
df["prioridade"] = hum.prioridade.reindex(df.index)
df["dia_previsto"] = pd.Series(dia_melhor, index=hum.index).reindex(df.index)
df["custo_espera"] = hum.custo_espera.reindex(df.index)
df["score"] = hum.score.reindex(df.index)

# antes x depois na fila inteira: hoje (FIFO em tudo, 150/dia, duplicados tratados 2x) vs proposta
# (automáticos resolvidos pelo agente no dia 0 + fila humana priorizada)
todos = raw.sort_values("data_abertura_excecao", kind="stable")
Hall = int(np.ceil(len(todos) / CAPACIDADE))
Lall = {t: pd.Series(perda(t), index=df.order_id.values) for t in range(Hall + 1)}
dia_all = np.arange(len(todos)) // CAPACIDADE
vistos = set()
perda_antes = 0.0
for oid, d_ in zip(todos.order_id.values, dia_all):
    if oid in vistos:
        continue
    vistos.add(oid)
    perda_antes += float(Lall[min(d_, Hall)][oid])
perda_auto = float(df.loc[df.fila == "automatica", "perda_hoje"].sum())
perda_depois = perda_auto + res[melhor]
perda_minima = float(df.perda_hoje.sum())

hoje = hum[hum.prioridade <= CAPACIDADE]
fifo_hoje = hum.iloc[pol["fifo"][:CAPACIDADE]]
# perda evitada hoje = perda que esses casos teriam se esperassem até o dia previsto no FIFO
ev_prior = float((hum.perda_5d - hum.perda_hoje)[hum.prioridade <= CAPACIDADE].sum())
ev_fifo = float((fifo_hoje.perda_5d - fifo_hoje.perda_hoje).sum())

# ---------------------------------------------------------------- achados (causa raiz)
periodo_meses = (np.datetime64("2026-09-27") - np.datetime64("2026-08-01")) / np.timedelta64(1, "D") / 30.4


def br(x, casas=1):
    return f"{x:.{casas}f}".replace(".", ",")


def milhar(n):
    return f"{int(n):,}".replace(",", ".")


def custo_caso(sub, reenvio=True):
    c = (sub.custo_reenvio if reenvio else 0) + CUSTO_CONTATO + sub.perda_hoje
    return float(c.sum())


def excesso(n, base):
    return max(0.0, float(n - base))


maq = df[df.tipo_excecao == "falha_personalizacao"].maquina.value_counts()
base_imp = maq.drop("IMP-02").mean()
it = df[df.tipo_excecao == "item_faltante"]
cdturno = it.groupby(["cd", "turno"]).size()
base_cd = cdturno.drop(("CD2", "noite")).mean()
vz = df[df.tipo_excecao == "vazamento_produto"]
lotes = vz.lote_produto.value_counts()
base_lote = lotes.drop("L2607-B").mean()
cn = df[df.transportadora == "Carga Norte"]
taxa_av_outros = (df[(df.transportadora != "Carga Norte")].tipo_excecao == "avaria_transporte").mean()
base_cn = len(cn) * taxa_av_outros
ent_atraso = df[df.tipo_excecao == "atraso_entrega"]
rota_ne = df[df.causa_rota_ne]
outros_ne = df[df.uf.isin(NE) & (df.transportadora != "Rota Express")]
tx_rota = (df[(df.transportadora == "Rota Express") & df.uf.isin(NE)].tipo_excecao.isin(["atraso_entrega", "rastreio_parado"])).mean()
tx_outros = outros_ne.tipo_excecao.isin(["atraso_entrega", "rastreio_parado"]).mean()
n_rota_ne_total = int(((df.transportadora == "Rota Express") & df.uf.isin(NE)).sum())
semana = pd.to_datetime(df.data_pedido).dt.isocalendar().week
rota_sem = df[df.causa_rota_ne].groupby(semana[df.causa_rota_ne]).size()

ruptura = df[df.tipo_excecao == "ruptura_pos_venda"]
rup_marca = ruptura.marca.value_counts()
rup_sku = ruptura.groupby(["sku", "descricao_produto"]).size().sort_values(ascending=False).head(5)

it_cd2n = it[(it.cd == "CD2") & (it.turno == "noite")]
it_outros = it[~((it.cd == "CD2") & (it.turno == "noite"))]
brinde_cd2n = it_cd2n.brinde_no_pedido.mean()
brinde_it_outros = it_outros.brinde_no_pedido.mean()
brinde_demais = df[df.tipo_excecao != "item_faltante"].brinde_no_pedido.mean()
# excesso de faltas com brinde fora do CD2 noite (lá o custo já está no achado do turno): quantas teriam brinde
# se o brinde não pesasse, com a parcela de brinde das demais exceções como patamar
it_outros_brinde = it_outros[it_outros.brinde_no_pedido]
exc_brinde = excesso(len(it_outros_brinde), len(it_outros) * brinde_demais)

sens_atraso = df.tipo_excecao.isin(["atraso_entrega"])
promessa_perda_sis = float(df.loc[sens_atraso, "perda_hoje"].sum())
promessa_perda_cor = float((p_cancel(df.atraso_sla_du.clip(lower=0)) * (df.valor + df.perda_cliente))[sens_atraso].sum())
exc_rota = n_rota_ne_total * (tx_rota - tx_outros)

achados = [
    {
        "id": "promessa",
        "titulo": "O checkout promete prazo em dias corridos, não em dias úteis",
        "area": "Sistema / checkout",
        "evidencia": f"Em 100% dos pedidos, a data prometida é a data do pedido mais (1 + SLA) dias corridos. A regra do negócio é em dias úteis. "
        f"O cliente recebe uma promessa em média {br(df.promessa_curta_du.mean())} dias úteis mais curta do que o contrato com a transportadora permite. "
        f"Dos {len(ent_atraso)} atrasos registrados, {int(df.causa_promessa.sum())} ({df.causa_promessa.sum()/len(ent_atraso):.0%}) estão dentro do SLA contratado: a transportadora cumpriu, a promessa é que estava errada.",
        "casos": int(df.causa_promessa.sum()),
        "acao": "Corrigir o cálculo da data prometida para dias úteis (com feriados). Zera esses 'atrasos fabricados' e reduz o risco de cancelamento em todos os outros.",
        "tipo": "processo",
        "custo_mensal": (promessa_perda_sis - promessa_perda_cor + df.causa_promessa.sum() * CUSTO_CONTATO) / periodo_meses,
        "graf": {"label": "Atrasos dentro x fora do SLA contratado", "dados": [
            {"k": "Dentro do SLA (promessa errada)", "v": int(df.causa_promessa.sum())},
            {"k": "Fora do SLA (atraso real)", "v": int(len(ent_atraso) - df.causa_promessa.sum())}]},
    },
    {
        "id": "rota_ne",
        "titulo": "Rota Express no Nordeste degradou a partir de setembro",
        "area": "Transportadora",
        "evidencia": f"{int(df.causa_rota_ne.sum())} atrasos e rastreios parados vêm da Rota Express em estados do Nordeste. "
        f"{tx_rota:.0%} das exceções da Rota no NE são atraso ou rastreio parado, contra {tx_outros:.0%} nas outras transportadoras na mesma região. "
        f"O volume salta na semana de 31/08 (semana 36) e se mantém.",
        "casos": int(df.causa_rota_ne.sum()),
        "acao": "Acionar a Rota Express com os dados (multa contratual / plano de ação) e migrar o volume do NE para a Entrega Já (SLA 5 du vs 6 du da Rota) enquanto o problema durar.",
        "tipo": "processo",
        "custo_mensal": exc_rota / len(rota_ne) * custo_caso(rota_ne, reenvio=False) / periodo_meses,
        "graf": {"label": "Atrasos + rastreio parado da Rota no NE por semana do pedido", "dados": [
            {"k": f"S{int(k)}", "v": int(v)} for k, v in rota_sem.items()]},
    },
    {
        "id": "imp02",
        "titulo": "A impressora IMP-02 gera 6x mais falhas de personalização",
        "area": "Produção (CD1)",
        "evidencia": f"{int(maq.get('IMP-02', 0))} das {int(maq.sum())} falhas de personalização ({maq.get('IMP-02', 0)/maq.sum():.0%}) saíram da IMP-02, nos três turnos. "
        f"As outras cinco impressoras têm em média {base_imp:.0f} falhas cada. Como acontece em todos os turnos, o problema é a máquina, não o operador.",
        "casos": int(maq.get("IMP-02", 0)),
        "acao": "Tirar a IMP-02 da fila para manutenção/calibração e redistribuir para IMP-01 e IMP-03. Reproduzir os itens pendentes em outra máquina.",
        "tipo": "processo",
        "custo_mensal": excesso(maq.get("IMP-02", 0), base_imp) / maq.get("IMP-02", 1) * custo_caso(df[df.causa_imp02]) / periodo_meses,
        "graf": {"label": "Falhas de personalização por impressora", "dados": [{"k": k, "v": int(v)} for k, v in maq.sort_index().items()]},
    },
    {
        "id": "cd2_noite",
        "titulo": f"O turno da noite do CD2 concentra {cdturno.get(('CD2', 'noite'), 0)/len(it):.0%} dos itens faltantes",
        "area": "Separação (CD2)",
        "evidencia": f"{int(cdturno.get(('CD2', 'noite'), 0))} dos {len(it)} itens faltantes ({cdturno.get(('CD2', 'noite'), 0)/len(it):.0%}) vêm do turno da noite do CD2; os outros cinco turnos têm em média {base_cd:.0f}. "
        "O problema é do turno, não do produto nem do CD inteiro: o CD2 de manhã e à tarde fica no patamar dos demais.",
        "casos": int(cdturno.get(("CD2", "noite"), 0)),
        "acao": "Conferir por bipagem todos os itens do pedido antes de fechar a caixa no turno da noite do CD2, e levantar o que muda nesse turno (equipe, volume por pessoa, treinamento, iluminação da bancada).",
        "tipo": "processo",
        "custo_mensal": excesso(cdturno.get(("CD2", "noite"), 0), base_cd) / cdturno.get(("CD2", "noite"), 1) * custo_caso(df[df.causa_cd2_noite]) / periodo_meses,
        "graf": {"label": "Itens faltantes por CD e turno", "dados": [{"k": f"{a} {b}", "v": int(v)} for (a, b), v in cdturno.items()]},
    },
    {
        "id": "brinde",
        "titulo": "Pedido com brinde de campanha tem mais item faltante, em todos os turnos",
        "area": "Separação (CD1 e CD2)",
        "evidencia": f"{it.brinde_no_pedido.mean():.0%} dos itens faltantes eram de pedidos com brinde, contra {brinde_demais:.0%} nas demais exceções. "
        f"Não é coisa de um turno: fora do turno da noite do CD2 a parcela é {brinde_it_outros:.0%}, e nele, {brinde_cd2n:.0%}. "
        "É uma associação: os dados não dizem qual item faltou, só que o pedido tinha brinde.",
        "casos": int(df.risco_brinde.sum()),
        "acao": "Pôr o brinde na lista de separação como item a bipar, igual aos itens comprados, em todos os turnos; e registrar na exceção qual item faltou, para confirmar se é o brinde.",
        "tipo": "processo",
        "custo_mensal": exc_brinde / max(1, len(it_outros_brinde)) * custo_caso(it_outros_brinde) / periodo_meses,
        "graf": {"label": "Parcela de pedidos com brinde", "unidade": "%", "dados": [
            {"k": "Itens faltantes, CD2 noite", "v": round(100 * brinde_cd2n)},
            {"k": "Itens faltantes, outros turnos", "v": round(100 * brinde_it_outros)},
            {"k": "Demais exceções", "v": round(100 * brinde_demais)}]},
    },
    {
        "id": "lote",
        "titulo": "Lote L2607-B do Condicionador Anti-Frizz 1000ml (Ápice) está vazando",
        "area": "Qualidade / fornecedor",
        "evidencia": f"{int(lotes.get('L2607-B', 0))} dos {len(vz)} vazamentos ({lotes.get('L2607-B', 0)/len(vz):.0%}) são do lote L2607-B, praticamente todos do mesmo produto. Os demais lotes têm em média {base_lote:.0f} vazamentos.",
        "casos": int(lotes.get("L2607-B", 0)),
        "acao": "Bloquear o lote no estoque, abrir não-conformidade com o fornecedor e reenviar de outro lote.",
        "tipo": "processo",
        "custo_mensal": excesso(lotes.get("L2607-B", 0), base_lote) / lotes.get("L2607-B", 1) * custo_caso(df[df.causa_lote]) / periodo_meses,
        "graf": {"label": "Vazamentos por lote (top 6)", "dados": [{"k": k, "v": int(v)} for k, v in lotes.head(6).items()]},
    },
    {
        "id": "carga_avaria",
        "titulo": "Carga Norte avaria 5x mais que as outras transportadoras",
        "area": "Transportadora",
        "evidencia": f"{int(df.causa_carga_avaria.sum())} das {int((df.tipo_excecao=='avaria_transporte').sum())} avarias são da Carga Norte, que tem só {len(cn)/len(df):.0%} das exceções. "
        f"Avaria é {(cn.tipo_excecao=='avaria_transporte').mean():.0%} das exceções dela contra {taxa_av_outros:.0%} nas demais.",
        "casos": int(df.causa_carga_avaria.sum()),
        "acao": "Pedir ressarcimento das avarias à Carga Norte e revisar embalagem/manuseio; se não melhorar, reduzir o volume com ela.",
        "tipo": "processo",
        "custo_mensal": excesso(df.causa_carga_avaria.sum(), base_cn) / max(1, df.causa_carga_avaria.sum()) * custo_caso(df[df.causa_carga_avaria]) / periodo_meses,
        "graf": {"label": "Avarias por transportadora", "dados": [{"k": k, "v": int(v)} for k, v in df[df.tipo_excecao == 'avaria_transporte'].transportadora.value_counts().items()]},
    },
    {
        "id": "ruptura",
        "titulo": "Ruptura pós-venda concentrada em poucos SKUs da Kokeshi",
        "area": "Estoque / site",
        "evidencia": f"{int(rup_marca.get('Kokeshi', 0))} das {len(ruptura)} rupturas ({rup_marca.get('Kokeshi', 0)/len(ruptura):.0%}) são da Kokeshi. Só o Óleo de Rosa Mosqueta 20ml (KSH-1010) responde por {int(rup_sku.iloc[0])}. O site vende o que não tem.",
        "casos": int(rup_marca.get("Kokeshi", 0)),
        "acao": "Sincronizar o estoque do site com o WMS para esses SKUs e travar a venda abaixo de um estoque de segurança.",
        "tipo": "processo",
        "custo_mensal": custo_caso(ruptura[ruptura.marca == "Kokeshi"], reenvio=False) / periodo_meses,
        "graf": {"label": "Rupturas por SKU (top 5)", "dados": [{"k": f"{a}", "v": int(v)} for (a, b), v in rup_sku.items()]},
    },
    {
        "id": "duplicados",
        "titulo": f"{len(dup_ids)} pedidos aparecem duas vezes na fila",
        "area": "Dados",
        "evidencia": f"{milhar(n_linhas)} linhas, mas só {milhar(len(df))} pedidos únicos: {len(dup_ids)} exceções foram registradas em dobro (mesmo pedido e tipo, status diferente). Sem limpar, duas pessoas tratam o mesmo caso ({br(len(dup_ids) * MIN_TRATATIVA / 60)} horas de trabalho jogadas fora).",
        "casos": int(len(dup_ids)),
        "acao": "Chave única por pedido + tipo de exceção na abertura. O app já funde os duplicados.",
        "tipo": "dados",
        "custo_mensal": 0,
        "graf": None,
    },
]
for a in achados:
    a["custo_mensal"] = round(float(a["custo_mensal"]), 2)

# ---------------------------------------------------------------- KPIs
risco_total = float(df.valor.sum())
perda_hoje_total = float(df.perda_hoje.sum())
auto_n = int((df.fila == "automatica").sum())
kpis = {
    "linhas": int(n_linhas),
    "pedidos": int(len(df)),
    "duplicados": int(len(dup_ids)),
    "valor_pedidos": round(risco_total, 2),
    "perda_esperada_hoje": round(perda_hoje_total, 2),
    "perda_esperada_5d": round(float(df.perda_5d.sum()), 2),
    "fila_humana": int(len(hum)),
    "fila_automatica": auto_n,
    "dias_para_zerar_fifo": H,
    "capacidade": CAPACIDADE,
    "horas_liberadas_automacao": round(auto_n * MIN_TRATATIVA / 60, 1),
    "politicas": {k: round(v, 2) for k, v in res.items()},
    "politica_escolhida": melhor,
    "dia_medio_teto": dia_teto,
    "alfa": ALFA,
    "promessa_perda_hoje": round(promessa_perda_sis, 2),
    "promessa_perda_corrigida": round(promessa_perda_cor, 2),
    "economia_vs_fifo": round(res["fifo"] - res[melhor], 2),
    "perda_antes": round(perda_antes, 2),
    "perda_depois": round(perda_depois, 2),
    "perda_minima": round(perda_minima, 2),
    "recuperado_backlog": round(perda_antes - perda_depois, 2),
    "dias_para_zerar_antes": Hall,
    "evitado_hoje_prior": round(ev_prior, 2),
    "evitado_hoje_fifo": round(ev_fifo, 2),
    "valor_hoje_prior": round(float(hoje.valor.sum()), 2),
    "valor_hoje_fifo": round(float(fifo_hoje.valor.sum()), 2),
    "custo_reenvio_medio": round(float(df.custo_reenvio.mean()), 2),
    "custo_reembolso_medio": round(float(df.custo_reembolso.mean()), 2),
    "clientes_vip": int(df.cliente_vip.sum()),
    "formula_corridos": formula_corridos,
    "promessa_curta_media": round(float(df.promessa_curta_du.mean()), 2),
    "por_tipo": [
        {"tipo": k, "n": int(len(g)), "valor": round(float(g.valor.sum()), 2), "perda_hoje": round(float(g.perda_hoje.sum()), 2),
         "perda_5d": round(float(g.perda_5d.sum()), 2)}
        for k, g in df.groupby("tipo_excecao")
    ],
    "por_status": {k: int(v) for k, v in df.status.value_counts().items()},
    "processo_mensal": round(sum(a["custo_mensal"] for a in achados if a["tipo"] == "processo"), 2),
    "casos_com_causa_sistemica": int(df[[c for c in df.columns if c.startswith("causa_")]].any(axis=1).sum()),
}

# ---------------------------------------------------------------- export
cols = [
    "order_id", "customer_id", "marca", "data_pedido", "valor", "sku", "descricao_produto", "qtd_itens", "brinde_no_pedido",
    "tipo_excecao", "status", "transportadora", "uf", "cidade", "data_prometida", "data_prometida_correta", "data_entrega",
    "maquina", "turno", "cd", "lote_produto", "data_abertura_excecao", "duplicado", "sla_contratado_dias_uteis",
    "custo_medio_frete", "n_pedidos", "receita_acumulada", "data_primeiro_pedido", "n_contatos_atendimento",
    "atraso_du", "atraso_sla_du", "promessa_curta_du", "entregue", "p_cancel_hoje", "perda_cliente", "perda_hoje", "perda_5d",
    "custo_espera", "score", "custo_reenvio", "custo_reembolso", "cliente_vip", "p_recompra", "fila", "prioridade", "dia_previsto",
] + [c for c in df.columns if c.startswith("causa_")] + ["risco_brinde"]
out = df[cols].copy()
for c in ["perda_cliente", "perda_hoje", "perda_5d", "custo_espera", "score", "custo_reenvio", "custo_reembolso"]:
    out[c] = out[c].round(2)
out = out.sort_values(["prioridade", "perda_hoje"], ascending=[True, False], na_position="last")
out = out.replace({np.nan: None})
(OUT / "casos.json").write_text(json.dumps(out.to_dict("records"), ensure_ascii=False, default=lambda o: o.item() if hasattr(o, "item") else str(o)), encoding="utf-8", newline="\n")
(OUT / "resumo.json").write_text(json.dumps({"kpis": kpis, "achados": achados}, ensure_ascii=False, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)), encoding="utf-8", newline="\n")
(OUT / "transportadoras.json").write_text(tra.to_json(orient="records", force_ascii=False), encoding="utf-8", newline="\n")

print(json.dumps(kpis, ensure_ascii=False, indent=1, default=str))
for a in achados:
    print("-", a["titulo"], "|", a["casos"], "| R$/mês", a["custo_mensal"])
