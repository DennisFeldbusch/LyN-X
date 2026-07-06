const util = require("util");
const fs = require("fs");
const path = require("path");
const { LyNX } = require("./src");

const args = process.argv.slice(2);

const printHelp = () => {
    console.log(`Usage:\n  node lyn-x.js <file> [options]\n\nOptions:\n  --help, -h         Show this help menu\n  --ast              Print parsed AST (inspected format)\n  --ast-json         Print parsed AST as JSON\n  --domain <url>     Base domain to prepend to relative URLs\n                     (e.g., https://example.com)\n  --json [file]      Write analysis results as JSON to file\n                     (default file: lynx-results.json)\n\nExamples:\n  node lyn-x.js tests/iife_scenarios_test.js\n  node lyn-x.js tests/iife_scenarios_test.js --domain https://example.com\n  node lyn-x.js tests/iife_scenarios_test.js --json\n  node lyn-x.js tests/iife_scenarios_test.js --json out/results.json\n  node lyn-x.js tests/iife_scenarios_test.js --ast-json`);
};

let filePath = "";
let showAst = false;
let showAstJson = false;
let jsonOutputFile = null;
let domain = null;

for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
        printHelp();
        process.exit(0);
    }
    if (arg === "--ast") {
        showAst = true;
        continue;
    }
    if (arg === "--ast-json") {
        showAstJson = true;
        continue;
    }
    if (arg === "--domain") {
        const maybeDomain = args[i + 1];
        if (maybeDomain && !maybeDomain.startsWith("--")) {
            domain = maybeDomain;
            i += 1;
        }
        continue;
    }
    if (arg === "--json") {
        const maybePath = args[i + 1];
        if (maybePath && !maybePath.startsWith("--")) {
            jsonOutputFile = maybePath;
            i += 1;
        } else {
            jsonOutputFile = "lynx-results.json";
        }
        continue;
    }
    if (!arg.startsWith("--") && !filePath) {
        filePath = arg;
        continue;
    }
}

if (!filePath) {
    printHelp();
    process.exit(1);
}

if (showAstJson) {
    const walker = new LyNX(filePath);
    console.log(JSON.stringify(walker.ast, null, 2));
    process.exit(0);
}

if (showAst) {
    const walker = new LyNX(filePath);
    const astText = util.inspect(walker.ast, {
        depth: 8,
        maxArrayLength: 50,
        compact: false,
        colors: false
    });
    console.log(astText);
    process.exit(0);
}

const walker = new LyNX(filePath);
walker.domain = domain;
const rows = walker.analyze({ printTable: !jsonOutputFile });

if (jsonOutputFile) {
    const outputPath = path.resolve(jsonOutputFile);
    const payload = {
        file: path.resolve(filePath),
        generatedAt: new Date().toISOString(),
        resultCount: rows.length,
        results: rows
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    console.log(`Wrote JSON results to ${outputPath}`);
}
