export function paraCSV(linhas: Record<string, unknown>[]): string {
  if (!linhas.length) return "";
  const cols = Object.keys(linhas[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // ponto e vírgula: abre direto no Excel em português
  return "﻿" + [cols.join(";"), ...linhas.map((l) => cols.map((c) => esc(l[c])).join(";"))].join("\n");
}
