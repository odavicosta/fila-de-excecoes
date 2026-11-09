import { NextResponse } from "next/server";
import { rodarAgente } from "@/lib/agente/agente";
import { casoPorId, pregeradoPorId } from "@/lib/dados";
import type { RespostaAgente } from "@/lib/tipos";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cache por instância: evita gastar a cota gratuita da IA com o mesmo pedido.
const cache = new Map<string, RespostaAgente>();
// Limite simples por IP para proteger a cota gratuita.
const janela = new Map<string, number[]>();
const LIMITE_POR_MINUTO = 20;

export async function POST(req: Request) {
  let orderId = "";
  let refazer = false;
  try {
    const corpo = await req.json();
    orderId = String(corpo?.order_id ?? "").trim().toUpperCase();
    refazer = Boolean(corpo?.refazer);
  } catch {
    return NextResponse.json({ erro: "Envie um JSON com order_id." }, { status: 400 });
  }
  if (!casoPorId(orderId)) return NextResponse.json({ erro: `Pedido ${orderId || "(vazio)"} não está na fila de exceções.` }, { status: 404 });

  if (!refazer && cache.has(orderId)) return NextResponse.json({ ...cache.get(orderId)!, do_cache: true });
  // Caso com tratativa pré-gerada pela IA: devolve na hora. "Rodar de novo" manda refazer e roda ao vivo.
  const pronto = !refazer && pregeradoPorId(orderId);
  if (pronto) return NextResponse.json(pronto);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const agora = Date.now();
  const recentes = (janela.get(ip) ?? []).filter((t) => agora - t < 60_000);
  if (recentes.length >= LIMITE_POR_MINUTO)
    return NextResponse.json({ erro: "Muitas execuções em um minuto. Espere alguns segundos e tente de novo." }, { status: 429 });
  recentes.push(agora);
  janela.set(ip, recentes);

  try {
    const r = await rodarAgente(orderId);
    if (r.modo === "ia") cache.set(orderId, r);
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ erro: String(e?.message ?? e) }, { status: 500 });
  }
}
