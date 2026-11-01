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
- [ ] 8. Tela de boas-vindas: criar o primeiro workspace, escolher agente e abrir o primeiro terminal em 2 cliques
- [x] 9. Orquestrador "Maestro" de verdade: preset com prompt de sistema que ensina o agente a usar `openmaestri` (list/ask/recruit/note)
- [ ] 10. Parcial: `openmaestri guide` e prompt inicial do Maestro existem; falta gerar AGENTS.md/CLAUDE.md por workspace (opt-in)

## C. Modelos abertos / DeepSeek
- [x] 11. Presets prontos: OpenCode (+ DeepSeek), Aider (+ DeepSeek), Claude Code, Codex, Gemini CLI, Goose
- [x] 12. Guia `docs/deepseek.md`: OpenCode com `DEEPSEEK_API_KEY` (provider deepseek) e Aider com `--model deepseek/deepseek-chat`
- [ ] 13. Parcial: chaves em `~/.openmaestri/env` fora do workspace.json; falta variáveis por preset/conta e chaveiro do SO
- [x] 14. Teste de integração do fluxo "Maestro recruta 2 workers e coordena" com um agente falso (script) para CI sem chave de API

## D. Produto
- [x] 15. Floors com git worktree (criar, status, land/merge, apagar). Falta: hooks e snapshots
- [x] 16. Partituras: salvar e reinserir layouts (agentes, notas, conexões)
- [x] 17. Automação de portal (snapshot/click/fill) via CDP por pipe
- [ ] 18. Empacotar em Electron (janela única, bandeja, notificações do SO) mantendo o modo navegador

## E. Distribuição e comunidade
- [x] 19. Pacote `.deb` (amd64) com binário `openmaestri`, `.desktop` e ícone, gerado por script e pelo CI
- [x] 20. GitHub Actions: lint, testes, build do .deb e anexo na Release por tag
- [x] 21. README no estilo do original (hero, quick start, o que faz, FAQ, docs)
- [ ] 22. Docs escritas em `docs/`; falta ativar o GitHub Pages (depende do merge do PR #1 em main)
- [x] 23. Templates de issue (bug com diagnóstico `openmaestri debug`, feature, pergunta) + guia "como reportar bug"
- [x] 24. CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, PR template, labels `good first issue`, licença MIT
- [ ] 25. Código publicado (PR #1 aberto, CI verde); falta merge, tag v0.1.0 e Release com o .deb

## G. Depois da fase 4 (planejadores kimi + agy)
- [x] Endurecimento: SSRF nos portais, hooks do git, teto de terminais, vazamento no export
- [x] `openmaestri doctor`, `recruit --model`, checagem do agente instalado
- [x] Árvore de arquivos e editor no canvas (v0.9.0) · [ ] floors a partir de PR e lista de PRs (gh/glab) · [ ] hooks e snapshots de floor
- [ ] Contas com chaveiro (secret://) · [ ] Electron (por último) · [ ] arrastar e soltar arquivos

## F. Fase 1 de paridade (feito em feature/canvas-parity)
- [x] Fichários (stacks), bands, partituras, desfazer/refazer, tidy, snap, paleta Ctrl+K, exportar/importar workspace
- [ ] Fase 2: floors com git worktree, landing, hooks; depois revisão de PRs
- [x] Fase 3: automação de portal (CDP)
- [ ] Fase 4: [x] chat com threads (say/recall) · [ ] memória resumida · [x] prompter (popup, preview, índice cancelável; falta arrastar e soltar) · [x] prompts salvos · [x] uso dos agentes (relatado/parseado, sem estimativa) · [x] descoberta/instalação de roles · [x] memória longa (local, sem modelo) · [ ] arrastar e soltar
