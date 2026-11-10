"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CasoResumido } from "@/lib/dados";
import { ACAO, CAUSA, STATUS, TIPO, brl, dataBR, num, pct } from "@/lib/rotulos";
import type { Caso, PassoAgente, RespostaAgente, Tratativa, TipoExcecao } from "@/lib/tipos";
import { paraCSV } from "@/lib/csv";

type Situacao = "pendente" | "aprovada" | "recusada";
type Registro = { resposta: RespostaAgente; situacao: Situacao; em: string };
type Aba = "hoje" | "humana" | "automatica";

const CHAVE = "fila-excecoes:tratativas:v1";
/** No plano gratuito do Groq cabem uns 3 casos por minuto; 5 é um lote que termina em 1-2 minutos. */
const TAMANHO_LOTE = 5;
const TENTATIVAS_COTA = 6;
/** O servidor aceita 3 execuções por minuto por pessoa; o lote espaça os casos para não bater nesse limite. */
const INTERVALO_MIN_S = 21;

const tempoTexto = (s: number) => (s < 60 ? `${Math.ceil(s)} segundos` : s < 3600 ? `${Math.ceil(s / 60)} minutos` : `${Math.round(s / 3600)} horas`);

function lerRegistros(): Record<string, Registro> {
  try {
    return JSON.parse(localStorage.getItem(CHAVE) || "{}");
  } catch {
    return {};
  }
}
function gravarRegistros(r: Record<string, Registro>) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(r));
  } catch {
    /* navegador sem armazenamento: segue só em memória */
  }
}

export default function Fila({
  casos,
  capacidade,
  inicial,
  abaInicial,
  idsPregerados = [],
}: {
  casos: CasoResumido[];
  capacidade: number;
  inicial?: string;
  abaInicial?: Aba;
  idsPregerados?: string[];
}) {
  const [aba, setAba] = useState<Aba>(abaInicial ?? "hoje");
  const [tipo, setTipo] = useState<string>("");
  const [busca, setBusca] = useState("");
  const [sel, setSel] = useState<string | null>(inicial ?? null);
  const [registros, setRegistros] = useState<Record<string, Registro>>({});
  const [lote, setLote] = useState<{ feitos: number; total: number; aguardandoAte?: number } | null>(null);
  const pregerados = useMemo(() => new Set(idsPregerados), [idsPregerados]);
  const [avisoLote, setAvisoLote] = useState<string | null>(null);
  const pararLote = useRef(false);

  useEffect(() => setRegistros(lerRegistros()), []);
  const salvar = useCallback((id: string, reg: Registro | null) => {
    setRegistros((r) => {
      const n = { ...r };
      if (reg) n[id] = reg;
      else delete n[id];
      gravarRegistros(n);
      return n;
    });
  }, []);

  const lista = useMemo(() => {
    let l = casos;
    if (aba === "hoje") l = l.filter((c) => c.fila === "humana" && (c.prioridade ?? 1e9) <= capacidade);
    else if (aba === "humana") l = l.filter((c) => c.fila === "humana");
    else l = l.filter((c) => c.fila === "automatica");
    if (tipo) l = l.filter((c) => c.tipo_excecao === tipo);
    const b = busca.trim().toUpperCase();
    if (b) l = l.filter((c) => c.order_id.includes(b));
    return [...l].sort((a, b) =>
      aba === "automatica" ? b.perda_5d - a.perda_5d : (a.prioridade ?? 1e9) - (b.prioridade ?? 1e9),
    );
  }, [casos, aba, tipo, busca, capacidade]);

  const resumoAba = useMemo(() => {
    const perda = lista.reduce((s, c) => s + (aba === "automatica" ? c.perda_hoje : (c.score ?? 0)), 0);
    return { n: lista.length, valor: lista.reduce((s, c) => s + c.valor, 0), perda };
  }, [lista, aba]);

  const rodar = useCallback(
    async (id: string, refazer = false, noLote = false): Promise<RespostaAgente | null> => {
      const r = await fetch("/api/agente", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: id, refazer }),
      });
      const j: RespostaAgente & { erro?: string } = await r.json();
      if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
      // No lote, uma tratativa do playbook por falta de cota não é guardada: o lote espera e roda o caso de novo.
      if (!(noLote && j.cota_esgotada)) salvar(id, { resposta: j, situacao: "pendente", em: new Date().toISOString() });
      return j;
    },
    [salvar],
  );

  /** Espera em pedaços curtos para o botão Parar responder na hora. */
  const aguardarCota = async (segundos: number, feitos: number, total: number) => {
    const ate = Date.now() + segundos * 1000;
    setLote({ feitos, total, aguardandoAte: ate });
    while (Date.now() < ate && !pararLote.current) await new Promise((r) => setTimeout(r, 250));
    setLote({ feitos, total });
  };

  const rodarLote = async (n: number) => {
    const alvo = lista.filter((c) => !registros[c.order_id] && !pregerados.has(c.order_id)).slice(0, n);
    if (!alvo.length) return;
    pararLote.current = false;
    setAvisoLote(null);
    setLote({ feitos: 0, total: alvo.length });
    lote: for (let i = 0; i < alvo.length && !pararLote.current; i++) {
      setSel(alvo[i].order_id);
      for (let tentativa = 1; tentativa <= TENTATIVAS_COTA && !pararLote.current; tentativa++) {
        const inicio = Date.now();
        let r: RespostaAgente | null = null;
        try {
          r = await rodar(alvo[i].order_id, false, true);
        } catch (e: any) {
          // Ex.: limite por pessoa. Insistir só gastaria mais tentativas.
          setAvisoLote(`O lote parou em ${i} de ${alvo.length}: ${String(e?.message ?? e)}`);
          break lote;
        }
        if (r?.cota_esgotada && r.limite === "dia") {
          // Limite diário não se resolve esperando segundos: para e explica.
          setAvisoLote(
            `O lote parou em ${i} de ${alvo.length}: a cota diária gratuita de IA acabou e volta em cerca de ${tempoTexto(r.espera_s ?? 3600)}. Os casos com tratativa pronta continuam abrindo.`,
          );
          break lote;
        }
        if (r?.cota_esgotada) {
          // Depois de várias esperas, fica com o playbook (com o aviso) para o caso não ficar sem tratativa.
          if (tentativa === TENTATIVAS_COTA) salvar(alvo[i].order_id, { resposta: r, situacao: "pendente", em: new Date().toISOString() });
          else await aguardarCota(r.espera_s ?? 20, i, alvo.length);
          continue;
        }
        // Entre um caso e outro, espera o que a cota pede e, no mínimo, o espaço do limite por pessoa (3 por minuto).
        const espera = Math.max(r?.espera_s ?? 0, INTERVALO_MIN_S - (Date.now() - inicio) / 1000);
        if (i < alvo.length - 1 && espera > 0) await aguardarCota(Math.ceil(espera), i + 1, alvo.length);
        break;
      }
      setLote({ feitos: i + 1, total: alvo.length });
    }
    setLote(null);
  };

  const [, tique] = useState(0);
  useEffect(() => {
    if (!lote?.aguardandoAte) return;
    const t = setInterval(() => tique((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [lote?.aguardandoAte]);

  const exportar = () => {
    const linhas = lista
      .filter((c) => registros[c.order_id])
      .map((c) => {
        const { resposta, situacao } = registros[c.order_id];
        const t = resposta.tratativa;
        return {
          prioridade: c.prioridade ?? "",
          pedido: c.order_id,
          tipo: TIPO[c.tipo_excecao as TipoExcecao],
          acao: t.acao_titulo,
          complementares: t.acoes_complementares.map((a) => ACAO[a]).join(" + "),
          quem_executa: t.executor === "agente" ? "agente" : "pessoa",
          situacao,
          custo_estimado: t.custo_estimado.toFixed(2).replace(".", ","),
          perda_se_esperar_5_dias: t.perda_evitada.toFixed(2).replace(".", ","),
          justificativa: t.justificativa,
          mensagem_cliente: t.mensagem_cliente,
          chamado_interno: t.chamado_interno,
          alerta_processo: t.alerta_processo ?? "",
          decidido_por: resposta.modo === "ia" ? `IA (${resposta.modelo})` : "playbook de regras",
        };
      });
    const blob = new Blob([paraCSV(linhas)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `plano-de-tratativas-${aba}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const comTratativa = lista.filter((c) => registros[c.order_id]).length;

  return (
    <div className="fila">
      <div className="lista">
        <div className="controles">
          <div className="abas" role="group" aria-label="Qual fila">
            <button aria-pressed={aba === "hoje"} onClick={() => setAba("hoje")}>
              Hoje ({capacidade})
            </button>
            <button aria-pressed={aba === "humana"} onClick={() => setAba("humana")}>
              Toda a fila
            </button>
            <button aria-pressed={aba === "automatica"} onClick={() => setAba("automatica")}>
              Automação
            </button>
          </div>
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Filtrar por tipo">
            <option value="">Todos os tipos</option>
            {Object.entries(TIPO).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input type="search" placeholder="Buscar pedido" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar pedido" />
        </div>
        <div className="controles" style={{ justifyContent: "space-between" }}>
          <span className="miudo">
            {num(resumoAba.n)} casos, {brl(resumoAba.valor)} em pedidos, {comTratativa} com tratativa
          </span>
          <span className="acoes">
            {lote ? (
              <button className="botao linha" onClick={() => (pararLote.current = true)}>
                <span className="carregando" />
                {lote.aguardandoAte
                  ? `Aguardando cota de IA: ${Math.max(1, Math.ceil((lote.aguardandoAte - Date.now()) / 1000))} s (${lote.feitos} de ${lote.total}). Parar`
                  : `Agente trabalhando: ${lote.feitos} de ${lote.total}. Parar`}
              </button>
            ) : (
              <button
                className="botao amarelo"
                onClick={() => rodarLote(TAMANHO_LOTE)}
                disabled={!lista.some((c) => !registros[c.order_id] && !pregerados.has(c.order_id))}
              >
                Rodar o agente nos próximos {TAMANHO_LOTE}
              </button>
            )}
            {aba === "automatica" ? (
              <a className="botao linha" href="/api/automacoes" style={{ textDecoration: "none" }}>
                Baixar as {num(casos.filter((c) => c.fila === "automatica").length)} automações
              </a>
            ) : (
              <button className="botao linha" onClick={exportar} disabled={!comTratativa}>
                Baixar plano (CSV)
              </button>
            )}
          </span>
        </div>
        {avisoLote && (
          <p className="decisao alerta" role="status" style={{ margin: "0 0 12px" }}>
            {avisoLote}
          </p>
        )}
        <div className="rolagem">
          <table className="tabela">
            <thead>
              <tr>
                <th className="n">{aba === "automatica" ? "" : "#"}</th>
                <th>Pedido</th>
                <th>Exceção</th>
                <th className="n opcional">Atraso</th>
                <th className="n" title="Quanto a perda esperada cresce se o caso esperar uma semana, mais metade do risco que ele já carrega">
                  {aba === "automatica" ? "Risco" : "Prioridade"}
                </th>
              </tr>
            </thead>
            <tbody>
              {lista.slice(0, 400).map((c) => {
                const reg = registros[c.order_id];
                return (
                  <tr
                    key={c.order_id}
                    aria-selected={sel === c.order_id}
                    className={reg?.situacao === "aprovada" ? "tratado" : undefined}
                    onClick={() => setSel(c.order_id)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setSel(c.order_id)}
                  >
                    <td className="n">{c.prioridade ?? ""}</td>
                    <td>
                      <b>{c.order_id}</b>
                      <div className="miudo">
                        {c.marca}, {c.uf}
                      </div>
                    </td>
                    <td>
                      {TIPO[c.tipo_excecao as TipoExcecao]}
                      <div>
                        {c.cliente_vip && <span className="etiqueta vip">Cliente alto valor</span>}
                        {c.causas.map((k) => (
                          <span key={k} className="etiqueta causa">
                            {CAUSA[k]}
                          </span>
                        ))}
                        {!reg && pregerados.has(c.order_id) && <span className="etiqueta">Tratativa pronta</span>}
                        {reg && (
                          <span className={`etiqueta ${reg.resposta.tratativa.executor}`}>
                            {reg.situacao === "aprovada" ? "Executada" : reg.situacao === "recusada" ? "Recusada" : reg.resposta.tratativa.executor === "agente" ? "Agente pode executar" : "Aguarda aprovação"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="n opcional">{c.atraso_du} {c.atraso_du === 1 ? "dia útil" : "dias úteis"}</td>
                    <td className="n">{brl(aba === "automatica" ? c.perda_hoje : (c.score ?? 0))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lista.length > 400 && <p className="miudo" style={{ padding: 12 }}>Mostrando os 400 primeiros de {num(lista.length)}. Use o filtro ou a busca.</p>}
          {!lista.length && <p className="vazio">Nenhum caso com esse filtro.</p>}
        </div>
      </div>
      <Painel id={sel} registro={sel ? registros[sel] : undefined} rodar={rodar} salvar={salvar} />
    </div>
  );
}

function Painel({
  id,
  registro,
  rodar,
  salvar,
}: {
  id: string | null;
  registro?: Registro;
  rodar: (id: string, refazer?: boolean) => Promise<RespostaAgente | null>;
  salvar: (id: string, r: Registro | null) => void;
}) {
  const [caso, setCaso] = useState<Caso | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [rodando, setRodando] = useState(false);

  const ref = useRef<HTMLElement>(null);
  const registroRef = useRef(registro);
  registroRef.current = registro;
  useEffect(() => {
    if (!id) return;
    if (window.innerWidth < 960) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCaso(null);
    setErro(null);
    fetch(`/api/caso?id=${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.erro) return setErro(j.erro);
        setCaso(j.caso);
        // Tratativa que a IA já gerou: aparece na hora, sem gastar cota. "Rodar de novo" roda ao vivo.
        if (j.pregerado && !registroRef.current) salvar(id, { resposta: j.pregerado, situacao: "pendente", em: new Date().toISOString() });
      })
      .catch(() => setErro("Não foi possível carregar o caso."));
  }, [id, salvar]);

  if (!id)
    return (
      <aside className="painel" ref={ref}>
        <div className="vazio">
          <h3>Escolha um caso</h3>
          <p style={{ marginTop: 8 }}>
            O agente investiga o pedido, o cliente, a transportadora e se o caso faz parte de um problema recorrente. Depois decide a tratativa, escreve a
            mensagem para o cliente e o chamado interno, e diz se pode executar sozinho ou se precisa de aprovação.
          </p>
        </div>
      </aside>
    );

  const executar = async (refazer = false) => {
    setRodando(true);
    setErro(null);
    try {
      await rodar(id, refazer);
    } catch (e: any) {
      setErro(String(e?.message ?? e));
    } finally {
      setRodando(false);
    }
  };

  return (
    <aside className="painel" aria-live="polite" ref={ref}>
      <header>
        <h2 style={{ fontSize: 22 }}>{id}</h2>
        {caso && (
          <p className="suave" style={{ marginTop: 4 }}>
            {TIPO[caso.tipo_excecao]}, {STATUS[caso.status] ?? caso.status}. {caso.descricao_produto}
          </p>
        )}
      </header>
      <div className="corpo">
        {erro && <p className="decisao alerta">{erro}</p>}
        {!caso && !erro && (
          <p className="suave">
            <span className="carregando" />
            Carregando o caso
          </p>
        )}
        {caso && (
          <>
            <dl className="ficha">
              <dt>Valor</dt>
              <dd>
                {brl(caso.valor, 2)}, {caso.qtd_itens} item(ns){caso.brinde_no_pedido ? " + brinde" : ""}
              </dd>
              <dt>Prometido</dt>
              <dd>
                {dataBR(caso.data_prometida)} ao cliente; pelo SLA seria {dataBR(caso.data_prometida_correta)}
              </dd>
              {caso.entregue && ["vazamento_produto", "avaria_transporte", "item_faltante"].includes(caso.tipo_excecao) ? (
                <>
                  <dt>Sem solução</dt>
                  <dd>
                    Entregue em {dataBR(caso.data_entrega!)} com problema; {caso.atraso_du} dias úteis sem solução desde o prazo,{" "}
                    {pct(caso.p_cancel_hoje)} de chance de cancelar
                  </dd>
                </>
              ) : (
                <>
                  <dt>Atraso</dt>
                  <dd>
                    {caso.atraso_du} dias úteis, {pct(caso.p_cancel_hoje)} de chance de cancelar
                  </dd>
                </>
              )}
              <dt>Cliente</dt>
              <dd>
                {caso.n_pedidos} pedidos, {brl(caso.receita_acumulada)} acumulados{caso.cliente_vip ? " (alto valor)" : ""}
              </dd>
              <dt>Logística</dt>
              <dd>
                {caso.transportadora} para {caso.cidade}/{caso.uf}, {caso.cd} turno da {caso.turno}
                {caso.maquina ? `, ${caso.maquina}` : ""}, lote {caso.lote_produto}
              </dd>
              <dt>Em risco</dt>
              <dd>
                {caso.perda_5d > caso.perda_hoje + 1
                  ? `${brl(caso.perda_hoje)} hoje, ${brl(caso.perda_5d)} se esperar 5 dias úteis`
                  : `${brl(caso.perda_hoje)}, já no teto da tabela de cancelamento`}
              </dd>
            </dl>

            {!registro && (
              <button className="botao amarelo" onClick={() => executar()} disabled={rodando}>
                {rodando ? (
                  <>
                    <span className="carregando" />
                    Agente investigando
                  </>
                ) : (
                  "Rodar o agente neste caso"
                )}
              </button>
            )}

            {registro && (
              <>
                <Passos passos={registro.resposta.passos} resposta={registro.resposta} />
                <Decisao t={registro.resposta.tratativa} />
                <div className="acoes">
                  {registro.situacao === "pendente" ? (
                    <>
                      <button className="botao" onClick={() => salvar(id, { ...registro, situacao: "aprovada" })}>
                        {registro.resposta.tratativa.executor === "agente" ? "Executar" : "Aprovar e executar"}
                      </button>
                      <button className="botao linha" onClick={() => salvar(id, { ...registro, situacao: "recusada" })}>
                        Recusar
                      </button>
                    </>
                  ) : (
                    <p className="suave">
                      {registro.situacao === "aprovada" ? "Tratativa executada." : "Tratativa recusada."}{" "}
                      <button className="botao linha" style={{ padding: "4px 10px", marginLeft: 6 }} onClick={() => salvar(id, { ...registro, situacao: "pendente" })}>
                        Desfazer
                      </button>
                    </p>
                  )}
                  <button className="botao linha" onClick={() => executar(true)} disabled={rodando}>
                    {rodando ? "Rodando" : "Rodar de novo"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

const NOME_FERRAMENTA: Record<string, string> = {
  investigar_caso: "Investigou pedido, cliente, transportadora, problema recorrente e opções",
  // nomes da versão anterior, que ainda aparecem nas tratativas pré-geradas antes da ferramenta única
  consultar_pedido: "Consultou o pedido",
  consultar_cliente: "Consultou o histórico do cliente",
  consultar_transportadora: "Consultou a transportadora",
  verificar_causa_sistemica: "Verificou se é problema recorrente",
  calcular_opcoes: "Calculou custo e alçada das opções",
  registrar_tratativa: "Registrou a tratativa",
};

function Passos({ passos, resposta }: { passos: PassoAgente[]; resposta: RespostaAgente }) {
  const ok = (p: PassoAgente) => p.tipo === "ferramenta" && !(p.resultado as { erro?: string } | undefined)?.erro;
  const consultas = passos.filter(ok);
  const tecnicos = passos.filter((p) => !(p.tipo === "aviso" && p.texto === resposta.aviso));
  return (
    <div>
      <h3>Investigação</h3>
      <p className="miudo" style={{ margin: "2px 0 8px" }}>
        {resposta.gerado_em && (
          <span className="etiqueta" style={{ marginRight: 6 }}>
            Resultado gerado em {resposta.gerado_em.slice(8, 10)}/{resposta.gerado_em.slice(5, 7)}
          </span>
        )}
        {resposta.modo === "ia" ? "Decidido pela IA" : "Decidido pelo playbook de regras"} em {(resposta.duracao_ms / 1000).toFixed(1).replace(".", ",")} s
        {resposta.gerado_em && ". Use “Rodar de novo” para rodar ao vivo."}
      </p>
      {resposta.aviso && (
        <p className="decisao alerta" style={{ marginBottom: 8 }}>
          {resposta.aviso}
        </p>
      )}
      <ol className="passos">
        {consultas.map((p, i) => (
          <li key={i} className="ferramenta">
            <span>{NOME_FERRAMENTA[p.nome ?? ""] ?? "Consultou os dados do caso"}</span>
          </li>
        ))}
      </ol>
      <details className="tecnico">
        <summary>Detalhes técnicos</summary>
        {resposta.modelo && <p className="miudo">Modelo: {resposta.modelo}</p>}
        <ol className="passos">
          {tecnicos.map((p, i) => (
            <li key={i} className={p.tipo}>
              {p.tipo === "ferramenta" ? (
                <details>
                  <summary>
                    <code>{p.nome}</code>
                  </summary>
                  <pre>{JSON.stringify(p.resultado, null, 1)}</pre>
                </details>
              ) : (
                <span>{p.texto}</span>
              )}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function Decisao({ t }: { t: Tratativa }) {
  return (
    <div className="decisao">
      <div>
        <span className={`etiqueta ${t.executor}`}>{t.executor === "agente" ? "O agente pode executar sozinho" : "Precisa de aprovação"}</span>
        <h3 style={{ marginTop: 6 }}>{t.acao_titulo}</h3>
        {!!t.acoes_complementares.length && <p className="suave">Junto: {t.acoes_complementares.map((a) => ACAO[a].toLowerCase()).join("; ")}</p>}
        <p className="miudo" style={{ marginTop: 4 }}>
          Custo estimado {brl(t.custo_estimado, 2)}. {t.motivo_alcada}
        </p>
      </div>
      <p>{t.justificativa}</p>
      <div>
        <p className="miudo">Mensagem para o cliente{t.executor === "pessoa" ? " (sai depois da aprovação)" : ""}</p>
        <blockquote>{t.mensagem_cliente}</blockquote>
      </div>
      {t.chamado_interno && t.chamado_interno !== "Sem chamado interno." && (
        <div>
          <p className="miudo">Chamado interno</p>
          <p className="interno">{t.chamado_interno}</p>
        </div>
      )}
      {t.alerta_processo && <p className="alerta">Problema recorrente: {t.alerta_processo}</p>}
    </div>
  );
}
