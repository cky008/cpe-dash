import { ConsoleSettings } from "../../src/console-settings.ts";
import { StorageCipher } from "../../src/encrypted-file.ts";
import type { AppConfig } from "../../src/types.ts";

/** The console store a daemon with `config` would open: loaded, or imported from its `.env` values (cheap scrypt). */
export function consoleSettingsFor(config: AppConfig): ConsoleSettings {
  const settings = new ConsoleSettings({ filePath: config.settingsFile, cipher: new StorageCipher(config.dataEncryptionKey), scryptCost: { N: 2 ** 10, r: 8, p: 1 } });
  if (!settings.load()) settings.importFromEnv(config);
  return settings;
}
