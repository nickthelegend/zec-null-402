# Evidence runner

Captures one page in headless Chrome for Testing. From the repo root:

```bash
node audit/runner/capture.mjs '{"id":"smoke-desktop","url":"https://example.com","width":1280,"height":800,"waitFor":"load","expectStatus":200,"allowStatuses":[]}'
```

The process prints `audit/evidence/runner-smoke/<id>.json` and exits 0 on pass. It acquires the `audit-kippu` heavy slot itself and releases that slot on exit.

`actions` is optional: `[{"type":"click","selector":"#go"},{"type":"fill","selector":"#q","text":"hello"},{"type":"press","selector":"#q","text":"Enter"}]`.

`outDir` is optional. When it is set, the screenshot and JSON are written under `audit/evidence/<outDir>/`. The name must match `^[a-z0-9][a-z0-9-]{0,40}$`.

```bash
node audit/runner/capture.mjs '{"id":"smoke-mobile","url":"https://example.com","width":375,"height":812,"outDir":"runner-mobile"}'
```
