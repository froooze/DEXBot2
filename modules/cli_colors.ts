/**
 * modules/cli_colors.ts - Centralized terminal color palette for CLI output.
 *
 * Single source of truth for ALL ANSI colors used across DEXBot2 CLIs
 * (`dexbot order`, `dexbot credit`, `dexbot bot`, `dexbot pm2`, `dexbot update`,
 * launcher status, order logger) so every command stays visually in lockstep.
 *
 * Consumers alias shared values (e.g. `ok: CLI_COLORS.brightGreen`) instead of
 * re-declaring literals. Rendered output is unchanged — only the definitions
 * moved here.
 *
 * Pure string constants — browser-safe, no Node dependencies.
 */

export const CLI_COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m', // bold style (combine with a color, e.g. spread + bold)
  // Analyzer (order/credit) greens/reds
  buy: '\x1b[92m', // green
  sell: '\x1b[91m', // light red
  buyDark: '\x1b[38;5;28m', // even darker green
  sellDark: '\x1b[31m', // dark red
  spread: '\x1b[93m', // yellow
  cyan: '\x1b[38;5;87m', // bright cyan
  gray: '\x1b[38;5;246m', // medium grey (lighter than bright black)
  white: '\x1b[97m', // bright white (spread bar, status muted, log info)
  // Warm section/field labels (bots editor, status, update)
  yellow: '\x1b[33m', // standard yellow (bots editor body text)
  yellowBold: '\x1b[1;33m', // bright yellow (bots editor section labels, status titles, update warnings)
  orange: '\x1b[38;5;208m', // orange (bots editor field labels, status labels)
  // Launcher ok/error
  brightGreen: '\x1b[1;92m', // bold bright green (startup/pm2/update ok)
  boldRed: '\x1b[1;31m', // bold red (startup/pm2/update errors, editor red)
  // Log levels / editor extras
  brightBlack: '\x1b[90m', // dark grey (log virtual orders)
  lightBlue: '\x1b[94m', // light blue (log partial orders)
  redStrong: '\x1b[38;5;196m', // strong red (log critical, editor redStrong)
  blue: '\x1b[38;5;39m', // bright blue (bots editor)
  sky: '\x1b[38;5;45m', // sky cyan (bots editor values)
  silver: '\x1b[38;5;250m', // light silver grey (bots editor)
  greenBold: '\x1b[1;32m', // bold green (bots editor)
} as const;

/**
 * Wrap text in one of the {@link CLI_COLORS} codes and reset afterwards —
 * the `c(colors.x, text)` helper each CLI used to declare locally.
 */
export function colorize(code: string, text: string): string {
  return `${code}${text}${CLI_COLORS.reset}`;
}
