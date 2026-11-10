# Fila de exceções: Operações Gocase e GoBeauté

Solução para o **Problema 2 (Operações)** do Desafio AI-First do Gogroup.

O time tem capacidade para 150 tratativas por dia e uma fila de 2.000 pedidos com exceção, tratada por ordem de chegada. A solução faz três coisas:

1. **Ordena a fila pela perda que cada caso evita** se for tratado agora, em vez da ordem de chegada.
2. **Põe um agente de IA para investigar e resolver cada caso**: ele consulta pedido, cliente e transportadora, verifica se o caso faz parte de um problema recorrente, calcula custo e alçada de cada opção e registra a tratativa com a mensagem para o cliente e o chamado interno. Ações simples ele executa sozinho; as que envolvem dinheiro acima da alçada vão para aprovação de uma pessoa.
3. **Aponta as causas raiz** que geram quase metade das exceções e que nenhuma tratativa individual resolve.

## Resultados (dados com referência em 30/09/2026)

| | Hoje (ordem de chegada) | Com a solução |
|---|---|---|
| Perda esperada na fila atual | R$ 128 mil | **R$ 105 mil** (recupera R$ 22.951) |
| Casos que ocupam uma pessoa | 2.042 linhas (com 42 duplicadas) | 1.451 (549 o agente resolve sozinho, 110 horas liberadas) |
| Dias para zerar a fila | 14 | 10 |

Causas raiz encontradas, com o custo mensal evitável estimado (total de cerca de **R$ 38 mil por mês**):

| Problema | Evidência | O que mudar |
|---|---|---|
| Turno da noite do CD2 esquece itens | 210 dos 278 itens faltantes (76%); 75% com brinde de campanha | Conferência obrigatória do brinde nesse turno |
| Rota Express no Nordeste | 396 atrasos e rastreios parados; 83% das exceções dela no NE contra 17% das outras; piora a partir de 31/08 | Acionar a transportadora e migrar o volume do NE |
| Carga Norte avaria | 98 das 186 avarias, com 17% das exceções | Ressarcimento e revisão de embalagem |
| Lote L2607-B (Condicionador Anti-Frizz 1000ml, Ápice) | 77 dos 111 vazamentos (69%) | Bloquear o lote e acionar o fornecedor |
| Checkout promete prazo em dias corridos | 100% das datas prometidas; 147 dos 497 "atrasos" (30%) estão dentro do SLA contratado | Corrigir o cálculo para dias úteis |
| Impressora IMP-02 | 77 das 130 falhas de personalização (59%), nos três turnos | Manutenção da máquina |
| Ruptura pós-venda na Kokeshi | 59 das 121 rupturas (49%) | Sincronizar estoque do site com o WMS |

## Como a prioridade é calculada

- **Atraso**: dias úteis entre a data prometida ao cliente e 30/09. Se o cliente ainda não tem o que comprou (não entregue, ou entregue com avaria, vazamento ou item faltando), o atraso continua contando.
- **Perda esperada** = chance de cancelamento pela faixa de atraso (parâmetros: 4%, 10%, 22%, 40%) × (valor pago + valor futuro do cliente em risco).
- **Valor futuro em risco** = 50% × chance de recompra (70% ou 28%) × receita anual do cliente × margem bruta de 76%.
- **Prioridade** = quanto a perda cresce se o caso esperar 5 dias úteis + metade da perda que ele já carrega.

Foram simulados sete critérios de ordenação sobre a fila humana, a 150 casos por dia. Ordem de chegada: R$ 97,1 mil de perda esperada. Proposta: R$ 84,2 mil. O critério "só urgência" dá R$ 78,1 mil, mas deixa os casos com mais de 10 dias de atraso esperando 6,2 dias em média, contra 4,2 na proposta. A explicação completa, com premissas e limites, está na página **Como decidimos** do app.

## O agente

`lib/agente/` tem o laço do agente (chamadas com *tool calling* no formato OpenAI) e duas ferramentas. O agente faz duas chamadas ao modelo por caso: investiga e decide.

| Ferramenta | O que faz |
|---|---|
| `investigar_caso` | Numa consulta só: pedido (prazos, situação da entrega, atraso ou dias sem solução, produção e separação), cliente (histórico, recompra, valor em risco), transportadora (SLA, frete, desempenho, alternativas na mesma UF), se o caso é parte de um problema recorrente, e custo, alçada e perda esperada de cada ação, com a ação padrão do playbook |
| `registrar_tratativa` | Grava a decisão; custo e alçada são calculados pelo sistema, não pelo modelo |

A alçada (`lib/regras.ts`) é fixa no código: o agente executa sozinho mensagens, cobranças, confirmações de endereço, links de pagamento e reenvios de até R$ 60 (87% dos casos). Reembolso, oferta de substituto, gastos acima de R$ 60 e qualquer gasto com cliente de alto valor vão para aprovação.

**Quando vira extravio.** Atraso na entrega e rastreio parado usam o mesmo critério: pedido não entregue há mais de 10 dias úteis além do SLA contratado é tratado como extravio (reenvio + cobrança da transportadora). Medimos contra o SLA porque extravio é falha da transportadora e a data do checkout está errada. O corte vem dos dados: nenhuma das 809 entregas da base chegou mais de 10 dias úteis depois do SLA (p95 = 6, p99 = 9). Hoje são 34 atrasos e 86 rastreios parados nessa situação. Antes, rastreio parado usava "mais de 5 dias úteis sobre a data prometida" e mandava 114 casos para extravio.

**Pedido entregue com problema não é atraso.** Em vazamento, avaria e item faltante (575 casos) o pedido chegou. `investigar_caso` diz isso em `situacao_entrega` ("entregue com problema em 10/08 (vazamento)...") e troca os campos de atraso por `dias_uteis_sem_solucao_desde_o_prazo_prometido`. Uma mensagem ao cliente que diga "atrasado" nesses casos volta para o modelo reescrever.

### Modelos e cota

O modelo roda no Groq (`gpt-oss-20b`, depois `gpt-oss-120b` e `qwen3.8-27b`, este com até 4.000 tokens de resposta porque raciocina antes de responder). O plano gratuito tem dois limites por modelo, compartilhados por **todos os visitantes do link**:

| Limite | Valor | O que acontece quando acaba |
|---|---|---|
| Por minuto | 8 mil tokens | Se a espera é de poucos segundos, o agente espera; senão, o próximo modelo assume |
| Por dia (janela móvel de 24 h) | 200 mil tokens | O modelo é pulado sem gastar requisição até a cota voltar |

Um caso gasta cerca de 5 mil tokens (duas chamadas: investigar e registrar). Antes eram três chamadas e cinco ferramentas de consulta; juntar tudo em `investigar_caso` cortou cerca de 44% dos tokens de entrada. Na prática o link aguenta **uns 3 casos por minuto e uns 120 por dia, somando os três modelos e todos os visitantes**. Casos com tratativa pronta e casos já rodados (cache) não gastam cota.

- **Um caso**: se nenhum modelo tiver cota, o playbook monta a tratativa e o app diz qual limite acabou e a espera real: "A cota gratuita de IA acabou por agora; esta tratativa veio do playbook. Tente de novo em 41 segundos." ou "A cota diária gratuita de IA acabou; esta tratativa veio do playbook. A IA volta em cerca de 12 minutos."
- **Lote de 5** ("Rodar o agente nos próximos 5"): espaça os casos (no mínimo 21 s, ou o que a cota pedir) e mostra "Aguardando cota de IA: N s". No limite por minuto, espera e roda o caso de novo (até 6 vezes). No limite diário, para e explica, porque esperar segundos não resolve.
- **Limite por pessoa**: 3 execuções por minuto e 25 por dia por IP (`LIMITE_POR_MINUTO` e `LIMITE_POR_DIA`), para um visitante não esgotar a cota dos outros.
- **Tratativas prontas**: os 15 primeiros casos da fila já têm a tratativa gerada pela IA em `lib/data/pregerados.json`. Ao abrir um deles, o resultado aparece na hora com a etiqueta "Resultado gerado em DD/MM"; "Rodar de novo" roda o agente ao vivo. Para gerar de novo: `node scripts/pregerar.mjs http://localhost:3000 15` com o app rodando.

### Travas no código

`registrar_tratativa` só é aceita depois de `investigar_caso`, e a ação precisa estar entre as opções do caso. Uma tratativa volta uma vez para o modelo corrigir quando a justificativa diz "dentro da alçada do agente" num caso que vai para aprovação, quando a mensagem diz "atrasado" num pedido entregue com problema, ou quando a justificativa ou a mensagem termina no meio de uma frase.

## Rodar localmente

```bash
npm install
cp .env.example .env.local   # coloque sua GROQ_API_KEY
npm run dev                  # http://localhost:3000
```

Para refazer a análise, coloque os CSVs do desafio em `dados/` (eles não estão no repositório, conforme as regras do desafio) e rode:

```bash
pip install pandas numpy
python3 analise/analise.py dados lib/data
```

## Publicar no Vercel

1. Importe o repositório em vercel.com/new (framework: Next.js, sem configuração extra).
2. Em *Environment Variables*, adicione `GROQ_API_KEY` com a chave do console.groq.com.
3. Deploy.

## Estrutura

```
analise/analise.py      análise em Python: limpeza, prazos, perda esperada, simulação e causas raiz
lib/data/               saída da análise usada pelo app e tratativas pré-geradas pela IA
scripts/pregerar.mjs    gera as tratativas dos primeiros casos da fila com o agente
lib/regras.ts           playbook, custos e alçada
lib/agente/             agente de IA e ferramentas
app/                    páginas (painel, fila do dia, causas raiz, método) e rotas de API
```

Feito por Davi Fernandes com Claude Code. Dados sintéticos fornecidos pelo Gogroup.
