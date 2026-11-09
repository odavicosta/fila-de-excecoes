import type { Metadata } from "next";
import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Fila de exceções · Operações Gocase e GoBeauté",
  description: "Prioriza os pedidos com exceção pela perda que cada um evita, aponta as causas raiz e põe um agente de IA para investigar e resolver cada caso.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ ["--fonte" as any]: "'Archivo Variable'" }}>
        <header className="topo">
          <div className="casca">
            <a href="/" className="marca">
              <i aria-hidden="true" />
              Fila de exceções
            </a>
            <Nav />
          </div>
        </header>
        <main>
          <div className="casca">{children}</div>
        </main>
        <footer className="rodape">
          <div className="casca">
            Desafio AI-First Gogroup, Problema 2 (Operações). Dados sintéticos com data de referência 30/09/2026. Feito por Davi Fernandes com Claude.
          </div>
        </footer>
      </body>
    </html>
  );
}
