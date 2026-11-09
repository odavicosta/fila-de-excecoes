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

`lib/agente/` tem o laço do agente (chamadas com *tool calling* no formato OpenAI) e as seis ferramentas:

| Ferramenta | O que faz |
|---|---|
| `consultar_pedido` | Pedido, prazos (prometido e correto pelo SLA), atraso, produção e separação |
| `consultar_cliente` | Histórico, chance de recompra, valor em risco, outras exceções abertas |
| `consultar_transportadora` | SLA, frete, desempenho na região e alternativas na mesma UF |
| `verificar_causa_sistemica` | Se o caso faz parte de um problema recorrente e quantos iguais existem |
| `calcular_opcoes` | Custo, alçada e perda esperada de cada ação possível, e a ação padrão do playbook |
| `registrar_tratativa` | Grava a decisão; custo e alçada são calculados pelo sistema, não pelo modelo |

A alçada (`lib/regras.ts`) é fixa no código: o agente executa sozinho mensagens, cobranças, confirmações de endereço, links de pagamento e reenvios de até R$ 60 (87% dos casos). Reembolso, oferta de substituto, gastos acima de R$ 60 e qualquer gasto com cliente de alto valor vão para aprovação.

O modelo roda no Groq (`gpt-oss-20b`, depois `gpt-oss-120b` e `qwen3.8-27b`). No plano gratuito cada modelo tem cerca de 8 mil tokens por minuto e um caso gasta de 5 a 7 mil, então: se o limite pede poucos segundos, o agente espera; se não, o próximo modelo assume. Se nenhum responder, o mesmo playbook monta a tratativa e o app avisa, para a solução nunca ficar fora do ar.

O código também segura o modelo: `registrar_tratativa` só é aceita depois de `calcular_opcoes`, a ação precisa estar entre as opções do caso, e uma justificativa que diga "dentro da alçada do agente" num caso que vai para aprovação é devolvida para correção.

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
lib/data/               saída da análise usada pelo app
lib/regras.ts           playbook, custos e alçada
lib/agente/             agente de IA e ferramentas
app/                    páginas (painel, fila do dia, causas raiz, método) e rotas de API
```

Feito por Davi Fernandes com Claude Code. Dados sintéticos fornecidos pelo Gogroup.
