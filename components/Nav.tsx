"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const itens = [
  { href: "/", rotulo: "Painel" },
  { href: "/fila", rotulo: "Fila do dia" },
  { href: "/causas", rotulo: "Causas raiz" },
  { href: "/metodo", rotulo: "Como decidimos" },
];

export default function Nav() {
  const p = usePathname();
  return (
    <nav className="nav" aria-label="Seções">
      {itens.map((i) => (
        <Link key={i.href} href={i.href} aria-current={p === i.href ? "page" : undefined}>
          {i.rotulo}
        </Link>
      ))}
    </nav>
  );
}
