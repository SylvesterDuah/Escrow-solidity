const path = require("node:path");

module.exports = {
  root: path.resolve(__dirname, "web3"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
};
