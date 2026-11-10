"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { TIPO, brl } from "@/lib/rotulos";
import type { TipoExcecao } from "@/lib/tipos";

type Celula = { id: string; tipo: TipoExcecao; dia: number | null; perda: number; auto: boolean };

export default function Armazem({ humana, auto, capacidade }: { humana: Celula[]; auto: Celula[]; capacidade: number }) {
  const router = useRouter();
  const [dica, setDica] = useState<{ x: number; y: number; t: string } | null>(null);

  const cel = (c: Celula, i: number) => (
    // Atalho visual para o mouse: fora da ordem de Tab e do leitor de tela (são 2.000). O link abaixo do gráfico faz o mesmo.
    <button
      key={c.id}
      tabIndex={-1}
      aria-hidden="true"
      data-dia={c.dia === 0 ? "0" : undefined}
      data-auto={c.auto ? "1" : undefined}
      onMouseMove={(e) =>
        setDica({
          x: e.clientX + 14,
          y: e.clientY + 14,
          t: `${c.auto ? "Automação" : `#${i + 1}`} · ${c.id}\n${TIPO[c.tipo]}\nPerda se esperar 5 dias: ${brl(c.perda)}`,
        })
      }
      onMouseLeave={() => setDica(null)}
      onClick={() => router.push(`/fila?pedido=${c.id}${c.auto ? "&aba=automatica" : ""}`)}
    />
  );

  return (
    <>
      <div className="armazem">
        <div className="bloco">
          <h3>
            Fila que precisa de uma pessoa <span>{humana.length.toLocaleString("pt-BR")} casos, na ordem de tratamento</span>
          </h3>
          <div className="celulas" aria-hidden="true" style={{ gridTemplateColumns: "repeat(60, minmax(0, 1fr))" }}>
            {humana.map(cel)}
          </div>
          <div className="legenda">
            <span style={{ ["--c" as any]: "var(--faixa)" }}>Tratados hoje ({capacidade} de capacidade)</span>
            <span style={{ ["--c" as any]: "var(--cinza-celula)" }}>Próximos dias</span>
          </div>
          <p style={{ marginTop: 10 }}>
            <Link href="/fila">Abrir a fila do dia</Link>
          </p>
        </div>
        <div className="bloco">
          <h3>
            Resolvidos por automação (playbook de regras) <span>{auto.length} casos, hoje</span>
          </h3>
          <div className="celulas celulas-auto" aria-hidden="true" style={{ gridTemplateColumns: "repeat(22, minmax(0, 1fr))" }}>
            {auto.map(cel)}
          </div>
          <div className="legenda">
            <span style={{ ["--c" as any]: "var(--agente)" }}>Lembretes, links de pagamento e pedidos de desculpa</span>
          </div>
        </div>
      </div>
      {dica && (
        <div className="dica" style={{ left: dica.x, top: dica.y, whiteSpace: "pre-line" }} role="tooltip">
          {dica.t}
        </div>
      )}
    </>
  );
}
