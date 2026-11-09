import { NextResponse } from "next/server";
import { casoPorId } from "@/lib/dados";
import { tratativaPorRegras } from "@/lib/regras";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const c = casoPorId(id);
  if (!c) return NextResponse.json({ erro: `Pedido ${id} não está na fila de exceções.` }, { status: 404 });
  return NextResponse.json({ caso: c, padrao: tratativaPorRegras(c) });
}
