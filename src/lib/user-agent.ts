import packageJson from "../../package.json";

/**
 * Identifies gamarr to third-party services (archive.org requires a tool name
 * and version: https://archive.org/developers/bots.html).
 */
export const GAMARR_USER_AGENT = `gamarr/${packageJson.version}`;
