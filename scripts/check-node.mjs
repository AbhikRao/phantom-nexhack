// Friendly preflight: PHANTOM and the generated backends run TypeScript natively and use node:sqlite (Node 22.18+).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`\nPHANTOM needs Node.js 22.18 or newer (you have ${process.versions.node}).\n` +
    '  Install a current version with nvm:  nvm install 22 && nvm use 22\n' +
    '  or download one from https://nodejs.org/\n');
  process.exit(1);
}
