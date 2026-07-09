# LyN-X
<p align="center">
<img width="229" height="262" alt="image" src="https://github.com/user-attachments/assets/c1c1605a-c216-4577-9846-087f3cfa292e" />
</p>

Fast, purely-static URL/endpoint extraction from JavaScript. Accepts a `.js` file, an HTML file, or
a URL, and reconstructs the URLs each network sink would request, while resolving variables, concatenation,
templates, objects and interprocedural flow. Unresolvable variables are templated as `{…}` placeholders.

## Run with Node

Requires Node.js (18+) and `acorn`.

```sh
npm install
node lyn-x.js <file.js | file.html | https://url> [options]
```

Options:

```
-r, --raw          Print only extracted URLs
-a, --all          Include non-URL fragments
    --recurse      Follow fully-resolved script URLs, fetch & re-analyze (default for URLs)
    --no-recurse   Disable recursion (default for local files)
    --max-depth N  Recursion depth cap (default: 3)
    --origin URL   Base origin/URL for resolving relative URLs (auto-set for URL input)
    --json [file]  Write results as JSON (default: lynx-results.json)
    --no-color     Disable ANSI colors
    --ast          Print the parsed AST (--ast-json for JSON)
-h, --help         Show help
```

## Standalone Binary

LyN-X can be compiled into a self-contained executable with `bun`.

Install Bun:

```sh
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc
```

Build:

```sh
bun install
bun build ./lyn-x.js --compile --minify --target=bun-linux-x64 --outfile lyn-x
```

Change `--target` (e.g. `bun-darwin-arm64`, `bun-windows-x64`) to build for another platform.
