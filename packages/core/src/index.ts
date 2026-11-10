/** @tatara/core: commands (and deploy), lifecycle, readiness, logger options, env, crypto, text and async helpers. */
import { createLifecycle } from "./lifecycle.ts";
import { createReadiness } from "./readiness.ts";

export { mapWithConcurrency } from "./async.ts";
export {
	type CommandContext,
	type CommandDefinition,
	type CommandLedger,
	defineCommand,
	flag,
	noArgs,
	parseFlags,
	runCommand,
	runDeploy,
} from "./commands.ts";
export { createLocalDefault } from "./config.ts";
export {
	CODE_ALPHABET,
	createEncryption,
	type Encryption,
	type EncryptionOptions,
	hashToken,
	isSealed,
	type KeyRingCheckOptions,
	type KeyRingOptions,
	numericCode,
	parseKeyRing,
	randomCode,
	randomToken,
	type SealFormat,
	safeEqual,
	validateKeyRing,
} from "./crypto.ts";
export { createLifecycle, type LifecycleOptions } from "./lifecycle.ts";
export { type CoreLogger, type LoggerConfig, levelToSeverity, loggerOptions } from "./logger.ts";
export { createReadiness } from "./readiness.ts";
export {
	type CleanTextOptions,
	cleanText,
	type SafeUrlOptions,
	safeUrl,
	text,
	url,
} from "./sanitize.ts";

// the app-wide instances; creating them only allocates state
const lifecycle = createLifecycle();
const readiness = createReadiness();
export const { onShutdown, waitUntil, shutdown, handleSignals } = lifecycle;
export const { registerReadinessCheck, runReadinessChecks } = readiness;
