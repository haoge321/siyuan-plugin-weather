const fs = require("fs");
const path = require("path");

const pluginOutputPath = path.resolve(__dirname, "weather");
// Optional: set SIYUAN_PLUGINS_PATH to auto-deploy the build to your local SiYuan
const siyuanPluginsPath = process.env.SIYUAN_PLUGINS_PATH || "";

class CopyPluginFiles {
  apply(compiler) {
    compiler.hooks.afterEmit.tap("CopyPluginFiles", () => {
      [
        "plugin.json",
        "README.md",
        "README_zh_CN.md",
        "LICENSE",
        "CHANGELOG.md",
        "icon.png",
        "preview.png",
        "index.css"
      ].forEach((fileName) => {
        fs.copyFileSync(
          path.resolve(__dirname, fileName),
          path.resolve(pluginOutputPath, fileName)
        );
      });

      const i18nSourcePath = path.resolve(__dirname, "i18n");
      if (fs.existsSync(i18nSourcePath)) {
        fs.cpSync(i18nSourcePath, path.resolve(pluginOutputPath, "i18n"), {
          recursive: true,
          force: true
        });
      }

      if (!siyuanPluginsPath || !fs.existsSync(siyuanPluginsPath)) {
        console.log(
          `SiYuan plugin directory not found, skip copying: ${siyuanPluginsPath}`
        );
        return;
      }

      const siyuanPluginOutputPath = path.join(siyuanPluginsPath, "weather");
      fs.cpSync(pluginOutputPath, siyuanPluginOutputPath, {
        recursive: true,
        force: true
      });
      console.log(`Plugin copied to: ${siyuanPluginOutputPath}`);
    });
  }
}

module.exports = {
  entry: "./src/index.ts",
  output: {
    path: pluginOutputPath,
    filename: "index.js",
    clean: true,
    library: {
      type: "commonjs2",
      export: "default"
    }
  },
  resolve: {
    extensions: [".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/
      }
    ]
  },
  externals: {
    siyuan: "siyuan"
  },
  plugins: [new CopyPluginFiles()]
};
