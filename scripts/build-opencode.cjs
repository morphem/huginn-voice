const babel = require("@babel/core"); const fs = require("fs")
const [src, out] = process.argv.slice(2)
const code = fs.readFileSync(src, "utf8")
const r = babel.transformSync(code, { filename: src, babelrc: false, configFile: false,
  presets: [[require.resolve("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
            [require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }]] })
fs.writeFileSync(out, "// Built from huginn-voice.tsx by scripts/build-opencode.cjs (do not edit; OpenCode does not compile JSX under node_modules).\n" + r.code + "\n")
