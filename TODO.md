# openmaestri: plano de trabalho

Meta: um orquestrador de agentes funcional e fácil de usar, open source, que rode também com modelos baratos/abertos (DeepSeek via OpenCode e outras ferramentas), com comunidade ajudando.

Legenda: [x] feito · [ ] pendente

## A. Fundação (feito)
- [x] 1. Analisar o Maestri (empacotamento, IPC, CLI, modelo de dados) e registrar em notas, sem copiar código
- [x] 2. Daemon Node: store JSON atômico, PTY (node-pty) + terminal headless para `check`/`ask`
- [x] 3. Socket Unix + CLI `openmaestri` (list, ask, check, notify, note, portal, recruit, dismiss, connect, arrange, preset, role, routine, workspace, floor status)
- [x] 4. Servidor web local com token + checagem de Host/Origin (shell é RCE, então loopback e autenticado)
- [x] 5. UI de canvas espacial (pan/zoom, terminais xterm.js, notas, portais, conexões, workspaces)
- [x] 6. Testes e2e (CLI dentro de PTY real) e de UI (Playwright)

## B. Fechar o MVP
- [x] 7. Corrigir o teste de UI (saída do CLI no terminal do navegador) e deixar `npm test` verde
- [x] 8. (v0.16.0) Tela de boas-vindas: criar o primeiro workspace, escolher agente e abrir o primeiro terminal em 2 cliques
- [x] 9. Orquestrador "Maestro" de verdade: preset com prompt de sistema que ensina o agente a usar `openmaestri` (list/ask/recruit/note)
- [x] 10. `openmaestri guide`, prompt inicial do Maestro e AGENTS.md/CLAUDE.md opcional na tela de boas-vindas (v0.16.0)

## C. Modelos abertos / DeepSeek
- [x] 11. Presets prontos: OpenCode (+ DeepSeek), Aider (+ DeepSeek), Claude Code, Codex, Gemini CLI, Goose
- [x] 12. Guia `docs/deepseek.md`: OpenCode com `DEEPSEEK_API_KEY` (provider deepseek) e Aider com `--model deepseek/deepseek-chat`
- [x] 13. chaves em `~/.openmaestri/env` fora do workspace.json; chaveiro e secret:// feitos (v0.10.0); contas por preset feitas (v0.17.0)
- [x] 14. Teste de integração do fluxo "Maestro recruta 2 workers e coordena" com um agente falso (script) para CI sem chave de API

## D. Produto
- [x] 15. Floors com git worktree (criar, status, land/merge, apagar). Falta: hooks e snapshots
- [x] 16. Partituras: salvar e reinserir layouts (agentes, notas, conexões)
- [x] 17. Automação de portal (snapshot/click/fill) via CDP por pipe
- [x] 18. Janela desktop opcional em Electron (janela única, bandeja, notificações) mantendo o modo navegador (v0.20.0)

## E. Distribuição e comunidade
- [x] 19. Pacote `.deb` (amd64) com binário `openmaestri`, `.desktop` e ícone, gerado por script e pelo CI
- [x] 20. GitHub Actions: lint, testes, build do .deb e anexo na Release por tag
- [x] 21. README no estilo do original (hero, quick start, o que faz, FAQ, docs)
- [x] 22. Docs em `docs/` publicadas no GitHub Pages
- [x] 23. Templates de issue (bug com diagnóstico `openmaestri debug`, feature, pergunta) + guia "como reportar bug"
- [x] 24. CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, PR template, labels `good first issue`, licença MIT
- [x] 25. Código publicado; releases com .deb a cada versão (v0.1.0 em diante)

## G. Depois da fase 4 (planejadores kimi + agy)
- [x] Endurecimento: SSRF nos portais, hooks do git, teto de terminais, vazamento no export
- [x] `openmaestri doctor`, `recruit --model`, checagem do agente instalado
- [x] Árvore de arquivos e editor no canvas (v0.9.0) · [x] lista de PRs e floors a partir de PR (gh/glab, v0.14.0) · [x] snapshots e rollback de floor (v0.15.0) · [x] hooks de floor (v0.18.0)
- [x] Chaves nomeadas com chaveiro (secret://, v0.10.0) · [x] contas por agente e por preset (v0.17.0) · [x] Electron (v0.20.0) · [x] arrastar e soltar arquivos no chat (v0.18.0)

## F. Fase 1 de paridade (feito em feature/canvas-parity)
- [x] Fichários (stacks), bands, partituras, desfazer/refazer, tidy, snap, paleta Ctrl+K, exportar/importar workspace
- [x] Fase 2: floors com git worktree, landing, hooks, snapshots; revisão de PRs (v0.18.0)
- [x] Fase 3: automação de portal (CDP)
- [x] Fase 4: [x] chat com threads (say/recall) · [x] memória resumida · [x] prompter (popup, preview, índice cancelável, arrastar e soltar) · [x] prompts salvos · [x] uso dos agentes (relatado/parseado, sem estimativa) · [x] descoberta/instalação de roles · [x] memória longa (local, sem modelo) · [x] arrastar e soltar

## H. Infraestrutura de teste (backlog)
- [ ] Máquina Spot de teste na AWS, **parada por decisão do dono em 2026-11-02, ligar com `start` quando precisar** (criada em 2026-11-02, **revisar até 2026-11-16**): decidir se ela passou a ser usada ou se é destruída com `scripts/aws-spot-check.sh down`. Acesso por SSH (porta 22 só para o IP do dono; `ssh-allow` renova se o IP mudar) ou SSM. Para economizar, `stop` quando ninguém usa.
- [x] Validar na máquina os drivers `opencode`, `codex`, `aider` e `goose` com os programas reais (feito em 2026-11-02, ver `docs/oneshot.md`); em 2026-11-03, com a chave do OpenRouter, os quatro deram resposta completa (o driver codex precisou de correção: CODEX_API_KEY e `-c openai_base_url`)
- [ ] Se a máquina for usada de verdade, rodar o CI de integração nela (testes com Docker, tmux e Chromium) em vez de depender da carga da máquina local
- [x] Desafio de orquestração rodado até o fim com agentes reais. Em 2026-11-03, com 10 dólares de crédito no OpenRouter, opencode com Nemotron 3 Ultra (free) de Maestro e gpt-oss-120b (pago, centavos) de equipe: PASSOU em 394s, 7/7 verificações, 9 mensagens (Dev 2, Auditor 7), custo total 1,4 centavo. Duas observações: o GLM 5.3 Flash como Maestro travou (tratou o desafio como "um bug" e perguntou ao humano pela ferramenta do opencode, sem recrutar ninguém), e o Nemotron reenviou a mesma pergunta ao Auditor 3 vezes. São limites de modelo, não do openmaestri. Falta: validar com o mesmo desafio os drivers codex, goose e aider.
- [x] Refino da orquestração (2026-11-03, a partir da crítica do Julio de que o APPROVED não provava encadeamento): `ask` devolvia só o rodapé da tela, voltava cedo com o modelo lento e perdia o 1º prompt de agente ainda iniciando; corrigidos. O desafio ganhou `--inject` (bug plantado) e checagem de repetição e de dados ditados. Rodada real 12/12: regras, Dev escreve, bug plantado, Auditor calcula e recusa, Dev corrige, Auditor aprova. Falta: o Nemotron recusou por engano em rodadas anteriores (limite do modelo); testar outros Maestros
- [x] Camada de validação (2026-11-03): `ask --check/--verdict/--retries/--then`, `agent --check`, `report`, guarda de laço, vigia do Maestro, aviso de resposta não verificada, tabela por modelo (docs/models.md). Matriz real de 4 Maestros: 3 passam (GLM 5.3 Flash, Nemotron 3 Ultra, Qwen 3.7 Flash), gpt-oss-120b falha como Maestro. Não feito: orçamento de tokens por execução, retomar orquestração após queda, aprovação de comandos perigosos pelo modelo fraco
- [x] Rodada 14 (2026-11-04/05): `ask --relay` (o programa copia a resposta do revisor), pasta do check na mensagem de falha, regra 11 do Maestro (enviar fontes, não resumos), tarefa B com armadilhas (`--scenario b`). Resultado: o repasse sozinho não resolveu a tarefa A (9 de 15, meta 11); na B o agente sozinho erra só com o Qwen (0 de 5); equipe com resumo do Auditor 7 de 15, equipe com o Dev lendo o arquivo 10 de 15 (solo 8 de 15 nos mesmos modelos): primeira pista de que a equipe compensa para o modelo fraco, n pequeno. Atualização com n=10 (dois conjuntos de dados): sozinho 17 de 30 (Qwen 1, gpt-oss 7, DeepSeek 9); equipe com o Dev lendo 19 de 28 (Qwen 6 de 8, gpt-oss 3 de 10, DeepSeek 10 de 10). A equipe ajuda quem não resolve sozinho (Qwen) e um bom coordenador levanta um trabalhador mais fraco (DeepSeek acima do gpt-oss), mas piora quando o Maestro é o elo fraco (gpt-oss). Falta: estado resumido pelo programa, veredito estruturado (plano do kimi) e outros trabalhadores além do gpt-oss
- [x] Rodada 13 (2026-11-04): nota quando o Auditor rejeita depois de um check que passou, corte do orçamento também para agentes de resposta única, `--baseline`. Resultado: um agente sozinho acerta 29 de 30 em cerca de 40 s e 1 a 2 centavos; a equipe 31 de 36 em 3 a 10 min e 3 a 31 centavos. Nesta tarefa a equipe não melhora a resposta. Falta: uma tarefa em que um agente sozinho erra com frequência (docs/validation-done.md)
- [x] Seis itens da rodada 12 (2026-11-04): gpt-oss como Maestro investigado (o caminho completo e a ferramenta de shell no bootstrap fizeram ele delegar), oráculo testado (`verify.py` deve imprimir a chave e recusar o script ruim), custo por execução com corte (`OPENMAESTRI_BUDGET_USD`), caixa como padrão para a equipe com chaves reais, `resume` após queda e estatística com 3 rodadas por Maestro. Resultado da estatística: GLM 5.3 Flash 2/3, gpt-oss-120b 1/3, Qwen 3.7 Flash 1/3, Nemotron 3 Ultra (free) 0/3 (2 sem começar). Falta: orçamento para agentes de uma resposta só, aprovação de comando perigoso pelo próprio modelo, codex/goose/aider na equipe do desafio, testar um Maestro pago de outra família
- [ ] Linha de base do desafio: o mesmo modelo sozinho (sem Maestro, Auditor nem gate) no mesmo flag.py, para saber se a orquestração compensa em custo por acerto. Ideia vinda da leitura do artigo sobre DeepSeek Harness/FrontierHarness (2026-11-04); a coluna de custo mediano por acerto já está na tabela
