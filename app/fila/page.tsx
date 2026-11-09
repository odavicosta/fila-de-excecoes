import Fila from "@/components/Fila";
import { casosResumidos, resumo } from "@/lib/dados";
import { brl, num } from "@/lib/rotulos";

export const metadata = { title: "Fila do dia · Fila de exceções" };

export default async function PaginaFila({ searchParams }: { searchParams: Promise<{ pedido?: string; aba?: string }> }) {
  const sp = await searchParams;
  const k = resumo.kpis;
  const lista = casosResumidos();
  return (
    <>
      <h1 style={{ maxWidth: "24ch" }}>Fila do dia</h1>
      <p className="lead">
        Os {k.capacidade} casos de hoje são os primeiros da ordem que, simulada na fila inteira, perde {brl(k.politicas.urgencia_risco)} contra{" "}
        {brl(k.politicas.fifo)} da ordem de chegada. Escolha um caso e rode o agente, ou deixe ele trabalhar nos próximos 10 da fila. Outros{" "}
        {num(k.fila_automatica)} casos ele resolve sem ocupar o time.
      </p>
      <Fila
        casos={lista}
        capacidade={k.capacidade}
        inicial={sp.pedido}
        abaInicial={sp.aba === "automatica" ? "automatica" : sp.pedido ? "humana" : "hoje"}
      />
    </>
  );
}
