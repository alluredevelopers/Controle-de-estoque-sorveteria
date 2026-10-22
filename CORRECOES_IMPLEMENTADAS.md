# Correções implementadas

Este documento resume a reconstrução técnica feita no sistema de controle de estoque da Sorveteria Pinguins.

## Acessos e permissões

- Dois perfis reais: administrador e colaborador.
- Primeiro administrador criado com chave de instalação protegida.
- Colaboradores criados exclusivamente pelo administrador.
- Login único, senha temporária e troca obrigatória no primeiro acesso.
- Permissões individuais para cadastrar produtos, registrar entradas e registrar saídas.
- Verificação das permissões no backend em todas as rotas protegidas.
- Ativação, desativação, edição e redefinição de senha dos colaboradores.
- Encerramento das sessões antigas ao alterar acesso, permissões ou senha.
- Recuperação administrativa protegida por uma chave de contingência separada.

## Segurança

- Sessão por cookie `HttpOnly`, `Secure` em produção e `SameSite=Lax`.
- Proteção de origem para requisições que alteram dados.
- Limite de tentativas de login, instalação e recuperação.
- Limpeza automática de tentativas antigas.
- Hash de senha com bcrypt.
- Credenciais temporárias geradas com fonte criptograficamente segura.
- Cabeçalhos de segurança e política CSP.
- Scanner local e de CI para impedir publicação de segredos, arquivos `.env`, chaves privadas, planilhas e backups.
- Valores sensíveis ficam somente em variáveis de ambiente.

## Integridade do estoque

- Produtos sempre começam com saldo zero.
- Saldo não pode ser alterado na edição comum do produto.
- Entradas, saídas e ajustes usam transações no PostgreSQL.
- Saída maior que o saldo é bloqueada atomicamente.
- Quantidades são calculadas como `NUMERIC(18,3)` no banco.
- Ajustes administrativos exigem motivo e geram movimentação auditável.
- Movimentações não são apagadas: a anulação mantém o original e cria uma reversão.
- Nome, categoria, unidade, saldo anterior e saldo posterior ficam preservados no histórico.
- Chave de idempotência evita lançamentos duplicados por toque duplo ou repetição de requisição.
- Produto com saldo não pode ser desativado.
- Produtos inativos continuam no histórico e podem ser reativados.

## Produtos, filtros e relatórios

- Categoria opcional no cadastro e na edição.
- Pesquisa de produto com autocomplete, teclado, toque e busca sem diferença de acentos.
- Unidades de medida padronizadas.
- Limites crítico e baixo configuráveis individualmente.
- Status automático: crítico, baixo e bom.
- Filtros de produtos por nome, categoria, saldo, status e situação.
- Filtros de movimentações por período, produto, categoria, quantidade, tipo, origem, responsável e situação.
- Paginação para produtos, movimentações, colaboradores e auditoria.
- Exportações CSV respeitam os filtros e são protegidas contra fórmula maliciosa em planilhas.

## Interface e responsividade

- Paleta oficial da Pinguins aplicada.
- Navegação adaptada a celular e computador.
- Tabelas convertidas em cartões nas telas menores.
- Formulários com rótulos visíveis.
- Estados de carregamento e botões bloqueados durante envios.
- Modais acessíveis por teclado, toque, tecla Escape e clique no fundo.
- Mensagens de erro e sucesso visíveis.
- Atualização automática dos dados a cada 30 segundos e ao retornar para a aba.

## Banco, implantação e manutenção

- Migrações versionadas com bloqueio consultivo no PostgreSQL.
- Migração compatível com a estrutura antiga, preservando usuários, produtos, saldos e movimentações.
- `@vercel/postgres` substituído por `pg` e gerenciamento de pool da Vercel.
- Dependência `xlsx` removida.
- CI no GitHub para scanner, testes e build.
- README e guia de segurança atualizados.

## Validações executadas nesta revisão

- 20 testes automatizados aprovados.
- Verificação de sintaxe dos módulos do backend.
- Análise estática dos arquivos React e JavaScript.
- Validação dos arquivos JSON.
- Scanner de segredos aprovado no conteúdo atual.

## Validações que dependem do ambiente publicado

As etapas abaixo devem acontecer depois da instalação das dependências e da configuração de um banco de teste:

- build completo do Vite;
- execução real das migrações em PostgreSQL;
- teste ponta a ponta no navegador;
- teste final em celular físico;
- teste de implantação na Vercel.

O ambiente de revisão não conseguiu baixar pacotes externos nem iniciar um PostgreSQL, portanto essas validações não foram simuladas como concluídas.
