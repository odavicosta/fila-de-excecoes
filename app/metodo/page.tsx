import { resumo } from "@/lib/dados";
import { LIMITE_AGENTE } from "@/lib/regras";
import { brl, dec, num, porExtenso } from "@/lib/rotulos";

export const metadata = { title: "Como decidimos · Fila de exceções" };

export default function Metodo() {
  const k = resumo.kpis;
  const curva = k.curva_alfa as { alfa: number; perda: number; espera_teto: number }[];
  const alfaEscolhido = curva.find((c) => c.alfa === k.alfa);
  const endDiv = (k.por_tipo as { tipo: string; perda_hoje: number }[]).find((t) => t.tipo === "endereco_divergente")?.perda_hoje ?? 0;
  return (
    <div className="texto">
      <h1 style={{ maxWidth: "20ch" }}>Como a fila é ordenada e o que o agente faz</h1>
      <p className="lead">Todas as contas saem dos parâmetros do negócio. O que é premissa nossa está dito como premissa.</p>

      <h2>1. Limpeza</h2>
      <ul>
        <li>
          {num(k.linhas)} linhas viram {num(k.pedidos)} pedidos: {k.duplicados} exceções estavam registradas duas vezes, iguais em tudo menos no status.
          Ficou o registro mais avançado.
        </li>
        <li>
          A data prometida do arquivo é sempre a data do pedido mais (1 + SLA) dias <b>corridos</b>. A regra do negócio é em dias úteis, contando a partir
          do primeiro dia útil depois do pedido e pulando os feriados de 07/09 e 12/10. Recalculamos a data correta para medir a transportadora; para o
          risco de cancelamento usamos a data que o cliente viu, porque é ela que ele cobra.
        </li>
      </ul>

      <h2>2. Quanto cada caso pode custar</h2>
      <p>
        Atraso: dias úteis entre a data prometida ao cliente e hoje (30/09). Se o pedido não chegou, ou chegou com avaria, vazamento ou item faltando, o
        atraso continua contando, porque o cliente ainda não tem o que comprou. Atraso que já foi entregue fica congelado na data de entrega.
      </p>
      <p>
        <b>Perda esperada</b> = chance de cancelamento pela faixa de atraso (4%, 10%, 22% ou 40%) × (valor pago, que vira reembolso + valor futuro do
        cliente em risco). No pagamento pendente não há reembolso: o que se perde é a venda que não se concluiu, então entra a margem dela (76% do
        valor) no lugar do valor pago.
      </p>
      <p>
        Valor futuro do cliente em risco = metade da chance de recompra (70% para quem passou de R$ 1.500 acumulados, 28% para os demais) × receita anual
        dele × margem bruta de 76% (100% menos o CMV de 24%). A metade vem do parâmetro: exceção mal resolvida corta a recompra pela metade. Premissa
        nossa: tratamos o cliente que cancela como o caso mal resolvido.
      </p>

      <h2>3. A ordem da fila</h2>
      <p>
        <b>Prioridade = quanto a perda esperada cresce se o caso esperar mais 5 dias úteis + metade da perda que ele já carrega.</b>
      </p>
      <p>
        A primeira parte pega quem está para mudar de faixa: um cliente com 2 dias de atraso tem 4% de chance de cancelar, com 7 dias tem 22%. A segunda
        parte evita que quem já passou de 10 dias, e está no teto de 40%, fique para o fim. Simulamos {num(k.fila_humana)} casos a {k.capacidade} por dia
        com {porExtenso(k.n_politicas)} critérios. Ordem de chegada dá {brl(k.politicas.fifo)} de perda esperada; a proposta, {brl(k.politicas.urgencia_risco)}. Usar só a
        urgência daria {brl(k.politicas.custo_espera)}, mas os casos no teto esperariam em média {dec(k.dia_medio_teto.custo_espera)} dias, contra{" "}
        {dec(k.dia_medio_teto.urgencia_risco)} na proposta. Preferimos pagar a diferença.
      </p>
      <p>
        <b>Por que o peso é 0,5.</b> A tabela de cancelamento para em &ldquo;mais de 10 dias&rdquo;: para o modelo, um caso com 30 dias de atraso não
        perde nada a mais se esperar outra semana, o que não é verdade. O peso sobre a perda que o caso já carrega corrige isso, e tem um preço. Testamos
        a curva:
      </p>
      <div className="lista" style={{ margin: "12px 0" }}>
        <table className="tabela">
          <thead>
            <tr>
              <th className="n">Peso</th>
              <th className="n">Perda esperada na fila humana</th>
              <th className="n">Espera média de quem já passou de 10 dias</th>
            </tr>
          </thead>
          <tbody>
            {curva.map((c) => (
              <tr key={c.alfa} style={{ cursor: "default", fontWeight: c.alfa === k.alfa ? 700 : undefined }}>
                <td className="n">{dec(c.alfa, 2)}</td>
                <td className="n">{brl(c.perda)}</td>
                <td className="n">{dec(c.espera_teto)} dias</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Cada dia a menos de espera custa mais que o anterior. Escolhemos {dec(k.alfa, 2)} porque é o menor peso testado que trata os casos no teto
        dentro de uma semana útil ({dec(alfaEscolhido?.espera_teto ?? 0)} dias, contra {dec(curva[1]?.espera_teto ?? 0)} com peso {dec(curva[1]?.alfa ?? 0, 2)}).
        Subir para {dec(curva[curva.length - 1].alfa, 2)} tira mais {dec((alfaEscolhido?.espera_teto ?? 0) - curva[curva.length - 1].espera_teto)} dia de espera
        por mais {brl(curva[curva.length - 1].perda - (alfaEscolhido?.perda ?? 0))}.
      </p>

      <h2>4. O que vai para uma pessoa, o que sai por automação e o que o agente de IA decide</h2>
      <p>
        {num(k.fila_automatica)} casos não precisam de análise: saem por automação (playbook de regras, sem IA) e liberam {dec(k.horas_liberadas_automacao)} horas de tratativa (12
        minutos cada).
      </p>
      <ul>
        <li>Aguardando cliente: lembrete com o que falta.</li>
        <li>Pagamento pendente: novo link de pagamento.</li>
        <li>Atraso já entregue: pedido de desculpas com cupom de 10%.</li>
      </ul>
      <p>Os demais formam a fila humana, onde o agente de IA investiga cada caso e propõe a tratativa. A alçada é fixa no código, e a IA não consegue mudá-la:</p>
      <ul>
        <li>Mensagens, cobrança da transportadora, confirmação de endereço e link de pagamento: o agente executa sozinho.</li>
        <li>Reenvio ou nova produção até {brl(LIMITE_AGENTE)} (87% dos casos custam menos que isso): o agente executa sozinho.</li>
        <li>Reembolso, oferta de substituto, gasto acima de {brl(LIMITE_AGENTE)} ou qualquer gasto com cliente de alto valor: uma pessoa aprova.</li>
      </ul>
      <p>
        <b>Quando vira extravio.</b> Atraso na entrega e rastreio parado seguem o mesmo critério: se o pedido não foi entregue e já passou mais de 10 dias
        úteis do SLA contratado, é tratado como extravio (reenvio + cobrança da transportadora); antes disso, cobramos a transportadora e avisamos o
        cliente. Medimos contra o SLA, e não contra a data do checkout, porque extravio é falha da transportadora e a data prometida ao cliente está
        errada. O corte vem dos dados: nenhuma das 809 entregas da base chegou mais de 10 dias úteis depois do SLA (95% chegaram em até 6). Hoje são 34
        atrasos e 86 rastreios parados nessa situação.
      </p>

      <h2>5. Como o agente trabalha</h2>
      <p>
        Para cada caso o agente faz duas chamadas ao modelo. Na primeira, investiga numa consulta só o pedido, o cliente, a transportadora, se o caso
        faz parte de um problema recorrente e o custo e a alçada de cada opção. Na segunda, registra a tratativa. O modelo escolhe a ação e escreve a
        justificativa, a mensagem para o cliente e o chamado interno. Custos e alçada são sempre calculados pelo sistema, nunca pelo modelo.
      </p>
      <p>
        Quando o pedido foi entregue com problema (vazamento, avaria ou item faltante), a consulta ao pedido diz isso e troca &ldquo;atraso&rdquo; por
        &ldquo;dias sem solução&rdquo;: o pedido chegou, então a mensagem ao cliente fala do problema e nunca diz que ele está atrasado. O sistema também
        devolve a tratativa para o modelo corrigir quando a justificativa contradiz a alçada ou quando um texto vem cortado no meio.
      </p>
      <p>
        O modelo roda no Groq, no plano gratuito: cada modelo tem 8 mil tokens por minuto e 200 mil por dia, divididos entre todos os visitantes, e um caso gasta cerca de 5 mil. Na prática são uns 3 casos por minuto e 120 por dia. O servidor lê a cota que resta
        e diz quanto tempo falta para caber o próximo caso. Se um modelo bate no limite, o próximo da lista assume; se nenhum tiver cota, o mesmo
        playbook de regras monta a tratativa e o app avisa. A solução nunca fica fora do ar por causa da IA. O botão &ldquo;Rodar o agente nos próximos
        5&rdquo; espera a cota entre um caso e outro (&ldquo;Aguardando cota de IA&rdquo;) em vez de aceitar o playbook, e para com um aviso quando a cota diária acaba.
      </p>
      <p>
        Os 15 primeiros casos da fila já vêm com a tratativa gerada pela IA, marcada com a data em que foi gerada, para abrir na hora sem gastar cota.
        &ldquo;Rodar de novo&rdquo; roda o agente ao vivo.
      </p>
      <p>
        Por que reenviar e não reembolsar: um reenvio custa em média {brl(k.custo_reenvio_medio, 2)} (CMV + frete), um reembolso{" "}
        {brl(k.custo_reembolso_medio, 2)}, e ainda arrisca o cliente.
      </p>

      <h2>6. Limites</h2>
      <ul>
        <li>A tabela de cancelamento só vai até &ldquo;mais de 10 dias&rdquo;. Um caso com 30 dias pesa igual a um com 11.</li>
        <li>
          Endereço divergente usa a mesma tabela de cancelamento por atraso, embora parte da demora dependa do cliente responder com o endereço certo.
          Mantivemos assim porque o cliente perde a paciência do mesmo jeito; a perda desses casos ({brl(endDiv)}) pode estar superestimada.
        </li>
        <li>Não sabemos o volume total de pedidos por máquina, turno ou lote, só os que deram exceção. Os excessos são medidos contra a média dos pares.</li>
        <li>O custo evitável das causas raiz supõe que, corrigido o processo, aquele tipo de exceção volta ao patamar dos pares.</li>
        <li>
          Na simulação, as automações resolvem o caso no mesmo dia. Na prática, parte dos clientes não responde ao lembrete ou não paga; esses voltam para a
          fila humana no dia seguinte.
        </li>
        <li>Nada é enviado de verdade: &ldquo;Executar&rdquo; registra a tratativa no navegador e entra no plano em CSV.</li>
      </ul>
    </div>
  );
}
