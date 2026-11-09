import { resumo } from "@/lib/dados";
import { LIMITE_AGENTE } from "@/lib/regras";
import { brl, dec, num } from "@/lib/rotulos";

export const metadata = { title: "Como decidimos · Fila de exceções" };

export default function Metodo() {
  const k = resumo.kpis;
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
        cliente em risco).
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
        com sete critérios. Ordem de chegada dá {brl(k.politicas.fifo)} de perda esperada; a proposta, {brl(k.politicas.urgencia_risco)}. Usar só a
        urgência daria {brl(k.politicas.custo_espera)}, mas os casos no teto esperariam em média {dec(k.dia_medio_teto.custo_espera)} dias, contra{" "}
        {dec(k.dia_medio_teto.urgencia_risco)} na proposta. Preferimos pagar a diferença.
      </p>

      <h2>4. O que vai para uma pessoa e o que o agente resolve</h2>
      <p>
        {num(k.fila_automatica)} casos não precisam de análise: o agente executa direto e libera {dec(k.horas_liberadas_automacao)} horas de tratativa (12
        minutos cada).
      </p>
      <ul>
        <li>Aguardando cliente: lembrete com o que falta.</li>
        <li>Pagamento pendente: novo link de pagamento.</li>
        <li>Atraso já entregue: pedido de desculpas com cupom de 10%.</li>
      </ul>
      <p>Nos demais, a alçada é fixa no código, e a IA não consegue mudá-la:</p>
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
        Para cada caso o agente usa seis ferramentas: consulta o pedido, o cliente e a transportadora, verifica se o caso faz parte de um problema
        recorrente, calcula custo e alçada de cada opção e, por fim, registra a tratativa. O modelo escolhe a ação e escreve a justificativa, a mensagem
        para o cliente e o chamado interno. Custos e alçada são sempre calculados pelo sistema, nunca pelo modelo.
      </p>
      <p>
        O modelo roda no Groq. Se um modelo bate no limite gratuito, o próximo da lista assume; se nenhum responder, o mesmo playbook de regras monta a
        tratativa e o app avisa. A solução nunca fica fora do ar por causa da IA.
      </p>
      <p>
        Por que reenviar e não reembolsar: um reenvio custa em média {brl(k.custo_reenvio_medio, 2)} (CMV + frete), um reembolso{" "}
        {brl(k.custo_reembolso_medio, 2)}, e ainda arrisca o cliente.
      </p>

      <h2>6. Limites</h2>
      <ul>
        <li>A tabela de cancelamento só vai até &ldquo;mais de 10 dias&rdquo;. Um caso com 30 dias pesa igual a um com 11.</li>
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
