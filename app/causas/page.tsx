import Barras from "@/components/Barras";
import { resumo } from "@/lib/dados";
import { brl, dec, num, porExtenso } from "@/lib/rotulos";

export const metadata = { title: "Causas raiz · Fila de exceções" };

const DESTAQUE: Record<string, (k: string) => boolean> = {
  promessa: (k) => k.startsWith("Dentro"),
  rota_ne: () => false,
  imp02: (k) => k === "IMP-02",
  cd2_noite: (k) => k === "CD2 noite",
  brinde: (k) => k.startsWith("Itens faltantes"),
  lote: (k) => k === "L2607-B",
  carga_avaria: (k) => k === "Carga Norte",
  ruptura: (k) => k.startsWith("KSH"),
};

const maiuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Causas() {
  const k = resumo.kpis;
  const achados = [...resumo.achados].sort((a, b) => b.custo_mensal - a.custo_mensal);
  return (
    <>
      <h1 style={{ maxWidth: "22ch" }}>
        {maiuscula(porExtenso(k.n_causas_raiz))} problemas estão ligados a quase metade das exceções
      </h1>
      <p className="lead">
        {num(k.casos_com_causa_sistemica)} dos {num(k.pedidos)} casos ({Math.round((k.casos_com_causa_sistemica / k.pedidos) * 100)}%) estão ligados a um problema
        recorrente que nenhuma tratativa individual resolve. Corrigir os processos abaixo evita cerca de {brl(k.processo_mensal)} por mês em reenvios,
        contatos e cancelamentos. O agente marca cada caso novo que cai num desses padrões e manda o alerta junto com a tratativa.
      </p>
      <div style={{ marginTop: 36 }}>
        {achados.map((a) => (
          <article key={a.id} className="achado">
            <div>
              <h2 style={{ fontSize: 21 }}>{a.titulo}</h2>
              <div className="meta">
                <span>
                  <b>{num(a.casos)}</b> casos
                </span>
                {a.custo_mensal > 0 && (
                  <span>
                    <b>{brl(a.custo_mensal)}</b> por mês evitáveis
                  </span>
                )}
                <span>{a.area}</span>
              </div>
              <p>{a.evidencia}</p>
              <p className="fazer">
                <b>O que mudar: </b>
                {a.acao}
              </p>
            </div>
            {a.graf && (
              <div>
                <p className="miudo" style={{ marginBottom: 8 }}>
                  {a.graf.label}
                </p>
                <Barras
                  classe="mini"
                  itens={a.graf.dados.map((d) => ({
                    rotulo: d.k,
                    valor: d.v,
                    texto: `${d.v}${a.graf!.unidade ?? ""}`,
                    ruim: a.id === "rota_ne" ? false : (DESTAQUE[a.id]?.(d.k) ?? false),
                    destaque: a.id === "rota_ne" && Number(d.k.slice(1)) >= 36,
                  }))}
                />
              </div>
            )}
          </article>
        ))}
      </div>
      <p className="miudo" style={{ marginTop: 20, maxWidth: "75ch" }}>
        Custo mensal evitável: casos acima do patamar normal (média das outras máquinas, turnos, lotes ou transportadoras) vezes o custo de cada caso
        (reenvio, contato de R$ 9 e perda esperada por cancelamento), dividido pelos {dec(k.periodo_meses)} meses do período. Na promessa de prazo, é a
        diferença de perda esperada entre o atraso medido pela data prometida e pelo SLA correto.
      </p>
    </>
  );
}
