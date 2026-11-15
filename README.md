# Monitor Genesis

Extensão Chrome (Manifest V3) que lê o painel interno de quedas do Genesis
(`painel_online_peso.php`) e avisa quando:

- vários **sites (end_id)** caem próximos no horário — **massiva**;
- um site **cai** (sai do painel);
- um site **normaliza** (volta ao painel).

Sem build, sem dependências, JS puro.

---

## Instalar / testar

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. **Carregar sem compactação** → selecione esta pasta.
4. Confira em **Configurações** (botão direito no ícone → *Opções*):
   - regionais (ex.: `TRJ`);
   - URL base do painel;
   - intervalo de verificação.
5. Abra o popup e clique **Verificar agora**.

A primeira verificação cria a base de comparação e já detecta massivas presentes no painel.
A partir da segunda, quedas e normalizações são detectadas.

> Ao alterar qualquer arquivo: `chrome://extensions` → **↻ Recarregar**.
> Alterou `content.js`? Recarregue também a aba do painel.

### Como saber se está funcionando

- Popup → **Diagnóstico**: mostra a última verificação, quantas linhas e
  quantos `end_id` foram lidos, e se a leitura veio por `fetch` ou por aba.
- Popup → **Última mudança**: o que caiu / normalizou na última checagem.
- Popup → **Massivas ativas**: massivas ainda válidas (1h).

### Log de erros

O service worker pode dormir; para ver mensagens, abra
`chrome://extensions` → *Monitor Genesis* → **Service worker** (inspecionar).

---

## Como funciona

```
alarme (intervalo) ──► performCheck()
                         │
                         ├─ loadState()            config + baseline anterior
                         ├─ fetchPanel(regional)   fetch da URL base + ?regional=XX
                         │     └─ fallback: aba aberta (content.js) se o fetch falhar
                         ├─ parseRows(html)        regex, sem DOMParser
                         ├─ groupEnds(items)       agrupa tecnologias por end_id
                         ├─ detectChanges()        novo end_id = caiu; end_id ausente = normalizou
                         ├─ findMassivas()         janela de tempo + threshold
                         ├─ mergeMassivas()        evita repetir a mesma massiva
                         └─ fireNotifications()    notificação nativa + janela de aviso
```

O parser roda no **service worker** (sem `DOMParser`), então o monitoramento
funciona com o painel fechado. A leitura por aba existe apenas como reserva.

### Por que a unidade é `end_id`, e não linha

O painel lista uma linha por **tecnologia** do mesmo site. Numa leitura real:

| métrica | valor |
|---|---|
| linhas da tabela | 391 |
| `end_id` distintos | 245 |

Contar linhas infla os números em ~1,6× e faz um site "normalizar" quando só
uma tecnologia voltou. Por isso tudo é agrupado por `end_id`:

- **caiu** = `end_id` que não existia na leitura anterior;
- **normalizou** = `end_id` que estava na anterior e sumiu, com o tempo fora;
- **massiva** = N `end_id` distintos com horários dentro de uma janela.

### Colunas lidas

Índices no `<td>` da tabela real (21 células):

| idx | conteúdo |
|---|---|
| 0 | checkbox (`name` = NE/site) |
| 1 | horário |
| 2 | duração |
| 6 | tecnologia (2G/3G/4G/5G) |
| 7 | site (NE) |
| 8 | `End_Id` — vem do `onClick=ngnis('...')` |
| 9 | ANF |
| 10 | cidade / UF |
| 13 | previsão |
| 14 | causa |
| 15 | detalhe |

O `End_Id` e o site **não** são lidos por posição fixa: vêm do `onClick` e do
`name` do checkbox. Isso evita o desalinhamento causado por um `<td>` malformado
na coluna Site (`<td>4G<td>4G-RJSZ43</td>`), presente em 392/392 linhas.

---

## Configurações

Chaves em `chrome.storage.sync` (prefixo `cfg_`), editáveis em `options.html`.

| campo | chave | padrão | descrição |
|---|---|---|---|
| Regionais | `regionals` | `TRJ` | lista separada por vírgula |
| Intervalo | `interval` | 10 min | frequência da verificação |
| Agrupar massiva por | `massivaGroup` | `end` | `end` \| `anf` \| `cidade` |
| Janela da massiva | `massivaWindowMin` | 10 min | proximidade de horário entre end_ids |
| Threshold da massiva | `massivaThreshold` | 5 | mínimo de end_ids na janela |
| Idade máxima | `massivaMaxDays` | 10 dias | quedas mais antigas não contam para massiva |
| Notificações nativas | `notifications` | ligado | notificação do Chrome |
| Avisar site caído | `notifyFallen` | ligado | só quando não houver massiva |
| Avisar normalização | `notifyNormalized` | ligado | inclui o tempo fora |
| URL base | `baseUrl` | `http://10.174.221.60/...painel_online_peso.php` | endpoint do painel |

Estado local (`chrome.storage.local`): `monitoring`, `toastsEnabled`,
`prevItems`, `lastDiff`, `lastInfo`, `history`, `massivas`, `dismissedMIds`.

### Mensagens (`chrome.runtime.sendMessage`)

`GET_STATUS` · `FORCE_CHECK` · `TOGGLE_MONITORING` · `TOGGLE_TOAST` ·
`UPDATE_SETTINGS` · `CLEAR_HISTORY` · `CLEAR_EVENTS` · `DISMISS_MASSIVA`
· `GET_ROWS` (usada pelo background para pedir as linhas à aba).

---

## Arquivos

| arquivo | papel |
|---|---|
| `manifest.json` | MV3, permissões, service worker, content script |
| `background.js` | parser, agrupamento, diff, massiva, alarme, notificações, mensageria |
| `content.js` | serializa as linhas do DOM (`cells`, `chk`, `end`) quando o fetch falha |
| `popup.html/.css/.js` | status, diagnóstico, última mudança, massivas, histórico |
| `notice.html/.css/.js` | janela de aviso (massiva, quedas, normalizações) |
| `options.html/.js` | configurações |
| `icons/` | ícones 16/48/128 |

---

## Verificação

Harness Node com stub de `chrome` (fora do projeto, em `C:/tmp/genesis-test/`):

```bash
node /c/tmp/genesis-test/harness.js \
  "/c/Users/<user>/Downloads/Extratores/monitor-genesis/background.js" \
  "C:/tmp/genesis-test/painel.html" \
  "C:/tmp/genesis-test/truth.json" \
  "C:/tmp/genesis-test/dom.html"
```

Cobre: parser contra o HTML real e contra o DOM renderizado, diff por `end_id`,
massiva (janela, threshold, agrupamento, idade), virada de ano e
`performCheck` de ponta a ponta (6 quedas + 3 normalizações simuladas).

Último resultado: **todos os testes passaram** (37 checks).

Checagens rápidas:

```bash
for f in background.js content.js popup.js notice.js options.js; do node --check "$f"; done
python -c "import json;json.load(open('manifest.json'))"
```

---

## Limitações conhecidas

- **1 linha de divergência**: o HTML bruto tem 392 linhas válidas, o navegador
  renderiza 391. A linha `RJRJO_0411` (14/11 20:44) tem aspas soltas no texto
  do Detalhe e o tokenizador do Chrome a descarta; o parser por regex a lê.
  Efeito prático: se a leitura alternar entre `fetch` e aba, esse único site
  pode aparecer como "normalizou". Com `fetch` funcionando, não ocorre.
- `host_permissions` usa `http://*/*` e `https://*/*` porque a URL base é
  configurável. Pode ser restringido ao IP interno.
- Não há teste automatizado de UI (popup, janela de aviso, opções).
- O botão de copiar usa `navigator.clipboard` com fallback `execCommand`.

---

## Progresso

### 1.1.0 — 14/11/2026

- Parser reescrito sem `DOMParser`; leitura por `fetch` passou a funcionar
  (antes caía sempre no caminho por aba).
- `End_Id` e site lidos por `onClick`/`name` do checkbox, imunes ao deslocamento
  de colunas.
- Unidade passou de linha para `end_id`; queda/normalização com agrupamento de
  tecnologias.
- Massiva por proximidade de horário (janela + threshold), com agrupamento
  configurável (`end`/`anf`/`cidade`) e merge de massivas repetidas.
- Alertas separados: massiva, site caído, site normalizado (com tempo fora).
- Botão **📋 Copiar NEs** na massiva (popup e janela de aviso) — copia todos os
  NE_IDs envolvidos, um por linha.
- Janela de aviso não fecha mais sozinha enquanto o mouse está sobre ela.
- `content.js` com guard contra listeners duplicados.
- Removido código morto (`SHOW_TOAST`, `toastInPage`).

### 1.0.x

- Versão inicial: monitoramento por aba aberta, avisos por ANF.

---

## Próximos passos (não implementados)

- Restringir `host_permissions` ao IP do painel.
- Botão para copiar também os `end_id` da massiva.
- Aba de diagnóstico com a janela de massiva detectada e os horários.
- Teste de UI automatizado.

### Correção de detecção (15/11/2026)
Massivas são calculadas sobre todos os sites atualmente fora, inclusive quedas recebidas em consultas diferentes. São detectados também incidentes em janelas separadas; consultas idênticas não repetem o alerta. Os limites e agrupamentos configurados continuam valendo.


## Versão 1.2.0 — Domus e ANF real

A fonte padrão passa a ser http://10.174.231.236/domus/genesis/online.
O monitor consulta o mesmo endpoint JSON usado pelo painel, com a regional configurada,
NE_ID e ordenação recente. Considera Flag 1 e agrega tecnologias pelo End_Id.
A ANF vem do campo `anf`, e não do quadrante C1/C2/C3/C4.
O agrupamento passa a ser exclusivamente por ANF, inclusive para configurações antigas.
O título, no popup, aviso e notificação, segue: `Massiva ANF21 -  - (30 sites afetados)`.
O mínimo configurado (padrão: 5 sites em 10 minutos) se aplica a cada ANF separadamente.
Sem ANF numérica, o site permanece no diagnóstico, mas não entra numa massiva.

Recarregue a extensão e a aba do Domus, entre no painel e clique em Verificar agora.
A leitura usa a sessão do navegador; se necessário, tenta a consulta pela aba aberta.
Resultados vazios válidos são aceitos. Em falha de uma regional, seus dados anteriores
são preservados para não anunciar normalizações indevidas.
Eventos antigos de outros agrupamentos são removidos da lista ao carregar esta versão.

Validação: HTML fornecido pelo usuário (443 linhas), ANF24 em Paraty e massiva ANF28
com cinco End_Ids; testes de migração, contagem sem duplicatas, primeira consulta,
alertas sem repetição e normalização em resposta vazia. A consulta autenticada em
produção ainda deve ser verificada no navegador após recarregar a extensão.
`nCorreção de unidade: site = NE_ID. O título e o mínimo da detecção contam NE_IDs distintos, inclusive tecnologias diferentes no mesmo End_Id. O End_Id continua apenas como agregador interno. Esta regra substitui a contagem anterior por End_Id.
