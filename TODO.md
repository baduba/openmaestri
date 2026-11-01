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
- [ ] 7. Corrigir o teste de UI (saída do CLI no terminal do navegador) e deixar `npm test` verde
- [ ] 8. Tela de boas-vindas: criar o primeiro workspace, escolher agente e abrir o primeiro terminal em 2 cliques
- [ ] 9. Orquestrador "Maestro" de verdade: preset com prompt de sistema que ensina o agente a usar `openmaestri` (list/ask/recruit/note)
- [ ] 10. Injetar instruções do CLI no agente (AGENTS.md/CLAUDE.md gerado por workspace) para qualquer ferramenta descobrir os comandos

## C. Modelos abertos / DeepSeek
- [ ] 11. Presets prontos: OpenCode (+ DeepSeek), Aider (+ DeepSeek), Claude Code, Codex, Gemini CLI, Goose
- [ ] 12. Guia `docs/deepseek.md`: OpenCode com `DEEPSEEK_API_KEY` (provider deepseek) e Aider com `--model deepseek/deepseek-chat`
- [ ] 13. Contas/perfis: variáveis de ambiente por preset, chaves guardadas fora do workspace.json (chaveiro do SO ou arquivo 0600)
- [ ] 14. Teste de integração do fluxo "Maestro recruta 2 workers e coordena" com um agente falso (script) para CI sem chave de API

## D. Produto
- [ ] 15. Floors com git worktree (criar, status, land/merge, apagar)
- [ ] 16. Partituras: salvar e reinserir layouts (agentes, notas, conexões)
- [ ] 17. Automação de portal (snapshot/click/fill) via Chromium/Playwright ou CDP
- [ ] 18. Empacotar em Electron (janela única, bandeja, notificações do SO) mantendo o modo navegador

## E. Distribuição e comunidade
- [ ] 19. Pacote `.deb` (amd64) com binário `openmaestri`, `.desktop` e ícone, gerado por script e pelo CI
- [ ] 20. GitHub Actions: lint, testes, build do .deb e anexo na Release por tag
- [ ] 21. README no estilo do original (hero, quick start, o que faz, FAQ, docs)
- [ ] 22. Site de documentação no GitHub Pages (guia, referência do CLI, arquitetura, DeepSeek)
- [ ] 23. Templates de issue (bug com diagnóstico `openmaestri debug`, feature, pergunta) + guia "como reportar bug"
- [ ] 24. CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, PR template, labels `good first issue`, licença MIT
- [ ] 25. Publicar no GitHub (baduba/openmaestri), tag v0.1.0 e Release com o .deb
