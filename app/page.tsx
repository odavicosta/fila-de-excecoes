import Armazem from "@/components/Armazem";
import Barras from "@/components/Barras";
import { casos, resumo } from "@/lib/dados";
import { TIPO, brl, dec, num } from "@/lib/rotulos";
import Link from "next/link";

const POLITICAS: Record<string, string> = {
  fifo: "Ordem de chegada (hoje)",
  maior_atraso: "Maior atraso primeiro",
  perda_hoje: "Maior risco atual",
  maior_valor: "Pedido mais caro primeiro",
  perda_5d: "Maior perda em 5 dias",
  urgencia_risco: "Urgência + risco (proposta)",
  custo_espera: "Só urgência",
};

const mil = (v: number) => `R$ ${Math.round(v / 1000).toLocaleString("pt-BR")} mil`;

export default function Painel() {
  const k = resumo.kpis;
  const humana = casos
    .filter((c) => c.fila === "humana")
    .sort((a, b) => (a.prioridade ?? 0) - (b.prioridade ?? 0))
    .map((c) => ({ id: c.order_id, tipo: c.tipo_excecao, dia: c.dia_previsto, perda: c.perda_5d, auto: false }));
  const auto = casos
    .filter((c) => c.fila === "automatica")
    .map((c) => ({ id: c.order_id, tipo: c.tipo_excecao, dia: null, perda: c.perda_5d, auto: true }));
  const nProcesso = resumo.achados.filter((a) => a.tipo === "processo").length;
  const pol = Object.entries(k.politicas as Record<string, number>)
    .filter(([p]) => POLITICAS[p])
    .sort((a, b) => b[1] - a[1]);

  return (
    <>
      <h1>Hoje o time trata {k.capacidade} exceções. Estas são as que mais evitam perda.</h1>
      <p className="lead">
        São {num(k.pedidos)} pedidos fora do fluxo e capacidade para {k.capacidade} tratativas por dia. Em vez de seguir a ordem de chegada, cada
        caso é ordenado pela perda que evita se for tratado agora. Os casos simples saem por automação (playbook de regras), e cada caso da fila humana chega
        investigado pelo agente de IA, com as mensagens prontas.
      </p>

      <Armazem humana={humana} auto={auto} capacidade={k.capacidade} />

      <div className="razao">
        <div>
          <span className="antes">{mil(k.perda_antes)}</span>
          <b>{mil(k.perda_depois)}</b>
          <p>
            de perda esperada na fila atual, contra {mil(k.perda_antes)} tratando por ordem de chegada. Recupera {brl(k.recuperado_backlog)}:{" "}
            {brl(k.economia_vs_fifo)} por tratar a fila humana na ordem certa e {brl(k.recuperado_backlog - k.economia_vs_fifo)} supondo que as{" "}
            {k.fila_automatica} automações resolvem o caso no mesmo dia (premissa otimista: quem não responde ao lembrete volta para a fila).
          </p>
        </div>
        <div>
          <b>{mil(k.processo_mensal)}</b>
          <p>por mês evitáveis corrigindo {nProcesso} causas raiz que geram {Math.round((k.casos_com_causa_sistemica / k.pedidos) * 100)}% das exceções.</p>
        </div>
        <div>
          <b>{Math.round(k.horas_liberadas_automacao)} horas</b>
          <p>de tratativa liberadas: {k.fila_automatica} casos resolvidos por automação (playbook de regras), sem ocupar uma pessoa.</p>
        </div>
        <div>
          <b>{k.dias_para_zerar_fifo} dias</b>
          <p>para zerar a fila que precisa de uma pessoa, contra {k.dias_para_zerar_antes} dias hoje (com {k.duplicados} casos duplicados a menos).</p>
        </div>
      </div>

      <section className="secao">
        <h2>Testamos sete jeitos de ordenar a mesma fila</h2>
        <p>
          Simulação com os {num(k.fila_humana)} casos que precisam de uma pessoa, {k.capacidade} por dia. Para cada caso, a perda esperada é a
          chance de cancelamento no dia em que ele for resolvido vezes o reembolso mais o valor futuro do cliente. Menor é melhor.
        </p>
        <Barras
          itens={pol.map(([p, v]) => ({
            rotulo: POLITICAS[p],
            valor: v,
            texto: mil(v),
            destaque: p === k.politica_escolhida,
            dica: `${POLITICAS[p]}: perda esperada ${brl(v)}; quem já passou de 10 dias úteis de atraso espera em média ${dec(k.dia_medio_teto[p])} dias`,
          }))}
        />
        <p className="miudo" style={{ marginTop: 12, maxWidth: "70ch" }}>
          &ldquo;Só urgência&rdquo; perde menos no modelo ({mil(k.politicas.custo_espera)}), mas empurra para o fim os casos que já passaram de 10 dias
          úteis de atraso (espera média de {dec(k.dia_medio_teto.custo_espera)} dias). A proposta soma metade do risco que o caso já
          carrega e trata esses clientes em {dec(k.dia_medio_teto.urgencia_risco)} dias, por {brl(k.politicas.urgencia_risco - k.politicas.custo_espera)} a mais.
        </p>
      </section>

      <section className="secao">
        <h2>Onde está o dinheiro em risco</h2>
        <p>
          {brl(k.valor_pedidos)} em pedidos com exceção. A perda esperada sobe de {mil(k.perda_esperada_hoje)} se tudo fosse resolvido hoje para{" "}
          {mil(k.perda_esperada_5d)} se a fila parasse por uma semana.
        </p>
        <div className="lista" style={{ marginTop: 18 }}>
          <table className="tabela">
            <thead>
              <tr>
                <th>Tipo de exceção</th>
                <th className="n">Casos</th>
                <th className="n opcional">Valor dos pedidos</th>
                <th className="n opcional">Perda esperada hoje</th>
                <th className="n">Se esperar 5 dias</th>
              </tr>
            </thead>
            <tbody>
              {[...(k.por_tipo as any[])]
                .sort((a, b) => b.perda_5d - a.perda_5d)
                .map((t) => (
                  <tr key={t.tipo} style={{ cursor: "default" }}>
                    <td>{TIPO[t.tipo as keyof typeof TIPO]}</td>
                    <td className="n">{num(t.n)}</td>
                    <td className="n opcional">{brl(t.valor)}</td>
                    <td className="n opcional">{brl(t.perda_hoje)}</td>
                    <td className="n">{brl(t.perda_5d)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="secao">
        <h2>O que fazer agora</h2>
        <p>
          <Link href="/fila">Abra a fila do dia</Link> e rode o agente em um caso para ver a investigação completa, ou veja as{" "}
          <Link href="/causas">causas raiz</Link> que precisam de mudança de processo.
        </p>
      </section>
    </>
  );
}
