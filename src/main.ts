// CLI エントリ。Bot の実装は Phase 2 で入れる。
const BOT_NAMES: string[] = [];

function usage(): void {
  console.error("Usage: node dist/main.js <bot>");
  console.error(
    `Available bots: ${BOT_NAMES.length > 0 ? BOT_NAMES.join(", ") : "(none yet)"}`,
  );
}

function main(): void {
  const name = process.argv[2];
  if (!name || !BOT_NAMES.includes(name)) {
    usage();
    process.exit(1);
  }
  console.error(`bot "${name}" is not implemented yet`);
  process.exit(1);
}

main();
