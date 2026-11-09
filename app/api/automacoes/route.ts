import { casos } from "@/lib/dados";
import { paraCSV } from "@/lib/csv";
import { TIPO } from "@/lib/rotulos";
import { tratativaPorRegras } from "@/lib/regras";

export async function GET() {
  const linhas = casos
    .filter((c) => c.fila === "automatica")
    .map((c) => {
      const t = tratativaPorRegras(c);
      return {
        pedido: c.order_id,
        cliente: c.customer_id,
        tipo: TIPO[c.tipo_excecao],
        status: c.status,
        acao: t.acao_titulo,
        executor: t.executor,
        custo_estimado: t.custo_estimado.toFixed(2).replace(".", ","),
        mensagem_cliente: t.mensagem_cliente,
      };
    });
  return new Response(paraCSV(linhas), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="automacoes-do-agente.csv"',
    },
  });
}
