# Controle de Estoque da Sorveteria Pinguins

> **Situação da publicação:** esta é a base corrigida do sistema, ainda com API na Vercel. A migração para **HostGator (frontend)** e **Supabase (autenticação, dados e operações)** ainda não foi implementada e precisa ser testada antes do uso operacional.

Aplicação web responsiva para controlar produtos, entradas, saídas, ajustes, relatórios e acessos individuais da equipe.

## Recursos principais

- dois níveis de acesso: administrador e colaborador;
- login e senha individuais;
- colaboradores criados exclusivamente pelo administrador;
- permissões independentes para cadastrar produtos, registrar entradas e registrar saídas;
- troca obrigatória da senha temporária no primeiro acesso;
- recuperação administrativa por chave de contingência protegida;
- categoria opcional no cadastro do produto;
- pesquisa de produto com sugestões automáticas;
- classificação configurável por produto em crítico, baixo e bom;
- filtros por produto, categoria, quantidade, situação, data, tipo, origem, responsável e status;
- histórico imutável, com anulação e reversão em vez de exclusão;
- ajuste administrativo com motivo obrigatório;
- proteção contra repetição da mesma movimentação;
- produtos inativos preservados e reativáveis;
- auditoria de alterações administrativas;
- exportação CSV compatível com Excel e Google Planilhas;
- atualização automática a cada 30 segundos;
- interface adaptada a celular e computador.

## Regras de acesso

### Administrador

O administrador controla produtos, limites de estoque, valores, categorias, ajustes, relatórios, auditoria e acessos da equipe.

### Colaborador

O colaborador recebe somente as funções marcadas pelo administrador:

- cadastrar produtos;
- registrar entradas;
- registrar saídas.

As permissões são verificadas no servidor. Ocultar um botão na interface não é usado como mecanismo de segurança.

## Regras de estoque

- todo produto novo começa com saldo zero;
- a quantidade não pode ser alterada na edição comum do produto;
- toda mudança de saldo ocorre por entrada, saída, ajuste ou reversão;
- não é possível registrar saída maior que o saldo disponível;
- um produto só pode ser desativado quando o saldo estiver zerado;
- movimentações não são apagadas;
- uma anulação mantém o lançamento original e cria a reversão correspondente;
- o limite crítico deve ser menor ou igual ao limite baixo;
- quantidades aceitam até três casas decimais;
- custos e preços aceitam até duas casas decimais.

## Tecnologia

- React 19 e Vite 8;
- Vercel Functions;
- PostgreSQL com `pg`;
- autenticação por cookie `HttpOnly` e JWT;
- migrações versionadas e protegidas por bloqueio no banco;
- testes com o executor nativo do Node.js.

## Variáveis de ambiente

Copie `.env.example` para `.env.local` e configure:

```env
DATABASE_URL=postgresql://...
JWT_SECRET=...
ADMIN_SETUP_SECRET=...
ADMIN_RECOVERY_SECRET=...
```

Requisitos mínimos:

- `JWT_SECRET`: 32 caracteres;
- `ADMIN_SETUP_SECRET`: 16 caracteres;
- `ADMIN_RECOVERY_SECRET`: 24 caracteres.

Use valores diferentes entre si. Nunca envie os valores reais ao GitHub.

## Desenvolvimento local

Requer Node.js 22.12 ou superior e npm 10.9 ou superior.

```bash
npm install
npm run dev
```

`npm run dev` usa a Vercel CLI para executar frontend e API no mesmo endereço.

Para trabalhar somente na interface:

```bash
npm run dev:frontend
```

## Testes e build

Antes de testes e publicação, execute a verificação de arquivos sensíveis:

```bash
npm run security:scan
```

```bash
npm test
npm run build
```

Ou execute os dois:

```bash
npm run check
```

O GitHub Actions repete os testes e o build em cada envio para a branch principal e em pull requests.

## Publicação na Vercel

1. Importe o repositório na Vercel.
2. Conecte um PostgreSQL, preferencialmente Neon com conexão agrupada.
3. Cadastre as quatro variáveis de ambiente.
4. Publique o projeto.
5. Abra o sistema e crie o primeiro administrador com `ADMIN_SETUP_SECRET`.
6. Guarde `ADMIN_RECOVERY_SECRET` fora do repositório para contingência.

## Antes de tornar o repositório público

Verifique o conteúdo atual e todo o histórico Git. Remover uma credencial do arquivo atual não a remove de commits antigos.

Confirme que não existem:

- arquivos `.env` reais;
- strings de conexão reais;
- tokens do GitHub ou da Vercel;
- senhas ou logins de produção;
- exportações do estoque;
- dados pessoais da equipe;
- backups de banco de dados.

Caso algum segredo tenha sido publicado em qualquer commit, revogue-o antes de abrir o repositório.
