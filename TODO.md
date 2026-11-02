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
- [ ] Máquina Spot de teste na AWS mantida de pé por um tempo (criada em 2026-11-02, **revisar até 2026-11-16**): decidir se ela passou a ser usada ou se é destruída com `scripts/aws-spot-check.sh down`. Enquanto existir, fica parada (`stop`) quando ninguém usa, para custar só o disco. Detalhes e estado: `scripts/aws-spot-check.sh status`.
- [ ] Validar na máquina os drivers `opencode`, `codex`, `aider` e `goose` com os programas reais (o instalador externo é bloqueado no computador local, mas a máquina descartável é o lugar certo para isso)
- [ ] Se a máquina for usada de verdade, rodar o CI de integração nela (testes com Docker, tmux e Electron/Xvfb) em vez de depender da carga da máquina local
