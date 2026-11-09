export type Barra = { rotulo: string; valor: number; texto: string; destaque?: boolean; ruim?: boolean; dica?: string };

export default function Barras({ itens, classe = "barras" }: { itens: Barra[]; classe?: string }) {
  const max = Math.max(...itens.map((i) => i.valor), 1);
  return (
    <div className={classe} role="list">
      {itens.map((i) => (
        <div key={i.rotulo} className={`barra${i.destaque ? " destaque" : ""}${i.ruim ? " ruim" : ""}`} role="listitem" title={i.dica ?? `${i.rotulo}: ${i.texto}`}>
          <span>{i.rotulo}</span>
          <span className="trilho">
            <span className="valor" style={{ display: "block", width: `${(i.valor / max) * 100}%` }} />
          </span>
          <span className="num">{i.texto}</span>
        </div>
      ))}
    </div>
  );
}
