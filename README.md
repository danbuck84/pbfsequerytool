# FSEconomy Query Tool

Primeira versão de uma pequena aplicação web que transforma os exemplos de URL do FSEconomy em formulários reutilizáveis, com os filtros inicialmente vazios.

## O que esta versão faz

- Seletor de consultas, agrupado por categoria.
- Campos dinâmicos de acordo com o endpoint escolhido.
- `userkey` e `readaccesskey` mantidos no servidor, fora do JavaScript do navegador.
- Conversão do XML para uma visualização em tabela no navegador.
- Abas para tabela, JSON interpretado e XML bruto.
- Exibição da URL usada com as chaves mascaradas por `***`.
- Consultas representadas a partir da lista fornecida: Aircraft, Assignments, Commodities, Facilities, FBOs, Flight Logs, Group Members, ICAO, Payments e Statistics.
- Nenhum filtro pessoal do exemplo original fica pré-preenchido.

## Requisitos

- Node.js 18 ou superior.
- FSEconomy API user key.
- Read access key para as consultas que exigem essa chave.

## Instalação

Esta versão não usa dependências externas. Não é necessário rodar `npm install`.

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

Edite `.env`:

```env
FSE_USER_KEY=sua_user_key_aqui
FSE_READ_ACCESS_KEY=sua_read_access_key_aqui
PORT=3000
```

Inicie:

```bash
npm start
```

ou diretamente:

```bash
node server.js
```

Depois abra:

```text
http://localhost:3000
```

## Segurança

O navegador não recebe as chaves reais da API. Ele envia ao servidor local somente o tipo de consulta e os filtros digitados. O servidor monta a URL do FSEconomy, executa a consulta e devolve a resposta XML. A URL mostrada na tela tem as chaves substituídas por `***`.

## Estrutura

```text
fse-query-tool/
├── server.js
├── package.json
├── .env.example
├── .gitignore
├── src/
│   ├── queries.js
│   └── fseApi.js
└── public/
    ├── index.html
    ├── app.js
    └── styles.css
```

## Observação sobre o CSV de aeroportos

A lista original também contém o endereço estático `https://server.fseconomy.net/static/airports.csv`. Ele não entrou no seletor dinâmico desta primeira versão porque não é uma consulta `/data` com filtros; é um download estático. Podemos adicioná-lo posteriormente como ferramenta separada de aeroportos.
