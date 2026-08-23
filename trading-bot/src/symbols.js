const DEFAULT_DISPLAY_NAME = 'Crash 900 Index';

async function resolveSymbol(client, displayName = DEFAULT_DISPLAY_NAME) {
  const symbols = await client.getActiveSymbols();
  const match = symbols.find((s) => s.display_name === displayName);

  if (!match) {
    const available = symbols
      .filter((s) => s.display_name.toLowerCase().includes('crash'))
      .map((s) => s.display_name)
      .join(', ');
    throw new Error(
      `Инструмент "${displayName}" не найден в active_symbols. ` +
        `Доступные Crash-инструменты: ${available || 'нет'}`
    );
  }

  return match.symbol;
}

module.exports = { resolveSymbol, DEFAULT_DISPLAY_NAME };
